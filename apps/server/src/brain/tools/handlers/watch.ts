/**
 * Хендлеры НАБЛЮДЕНИЯ/мониторинга (§долгие-задачи) — durable повторяющаяся проверка условия + проактивная
 * озвучка при срабатывании. create/cancel/list. Зеркалит хендлеры напоминаний; маршрутизация — в dispatch (switch).
 */
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, ok } from "../dispatch-util.js";

export function watchCreate(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  if (!ctx.watch || !ctx.sessionId) return err("Наблюдение сейчас недоступно (нет канала озвучки).");
  const what = String(input.what ?? "").trim();
  const condition = String(input.condition ?? "").trim();
  if (!what || !condition) return err("watch_create: нужны и what (что отслеживать), и condition (при каком условии уведомить).");
  // §Волна3 (3.4): локальный предикат (форма wait_for.condition) — проверка на КЛИЕНТЕ ($0, каждые
  // ~5с), без LLM-чекера. Валидируем минимально (kind обязателен) — полную проверку делает клиент.
  const rawPredicate = input.predicate;
  const predicate =
    rawPredicate && typeof rawPredicate === "object" && typeof (rawPredicate as { kind?: unknown }).kind === "string"
      ? rawPredicate
      : undefined;
  if (rawPredicate !== undefined && !predicate) return err("watch_create: predicate должен быть объектом-условием с полем kind (как у wait_for).");
  const everySec = Number(input.every_seconds);
  const intervalMs = Number.isFinite(everySec) && everySec > 0 ? everySec * 1000 : predicate ? 10_000 : 300_000; // деф: предикат 10с, LLM 5 мин
  const continuous = input.continuous === true;
  const res = ctx.watch.add({ sessionId: ctx.sessionId, userId: ctx.userId, what, condition, intervalMs, continuous, predicate });
  if (!res.ok) {
    return res.reason === "limit"
      ? err("Слишком много активных наблюдений — сними одно (watch_cancel), прежде чем добавить новое.")
      : err("watch_create: некорректные параметры наблюдения.");
  }
  const w = res.watch;
  const period = Math.round(w.intervalMs / 1000);
  return ok(
    `Поставил наблюдение: слежу за «${w.what}», уведомлю когда «${w.condition}». ` +
      `Проверяю каждые ${period} с${predicate ? " локальным предикатом на клиенте ($0)" : ""}, ${w.continuous ? "слежу постоянно" : "уведомлю один раз"}. id=${w.id}`,
  );
}

export function watchCancel(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  if (!ctx.watch) return err("Наблюдение сейчас недоступно.");
  const query = String(input.query ?? "").trim();
  if (!query) return err("watch_cancel: пустой query.");
  const cancelled = ctx.watch.cancel(query, ctx.userId);
  return cancelled ? ok(`Снял наблюдение: «${cancelled.what}».`) : err(`Не нашёл активного наблюдения по «${query}».`);
}

export function watchList(ctx: ToolContext): ToolResult {
  if (!ctx.watch) return err("Наблюдение сейчас недоступно.");
  const items = ctx.watch.list({ userId: ctx.userId });
  if (items.length === 0) return ok("Активных наблюдений нет.");
  const lines = items.map(
    (w) =>
      `• «${w.what}» → уведомлю когда «${w.condition}» (каждые ${Math.round(w.intervalMs / 1000)} с${w.continuous ? ", постоянно" : ""}, id=${w.id})`,
  );
  return ok(`Активные наблюдения:\n${lines.join("\n")}`);
}

/**
 * Хендлеры НАБЛЮДЕНИЯ/мониторинга (§долгие-задачи) — durable повторяющаяся проверка условия + проактивная
 * озвучка при срабатывании. create/cancel/list. Зеркалит хендлеры напоминаний; маршрутизация — в dispatch (switch).
 */
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, ok } from "../dispatch-util.js";

/**
 * §Волна3 ревью (#12): валидация предиката ПО СТРУКТУРЕ на постановке. Раньше проверялось лишь
 * typeof kind === 'string' → опечатка в kind ({kind:'windows'}) или gsi без path принимались с ответом
 * «Поставил наблюдение», но на клиенте вечно давали met:false (неотличимо от «условие не наступило») —
 * ложный успех постановки: уведомление невозможно в принципе. Возвращаем причину, чтобы модель поправила.
 */
function validatePredicate(raw: unknown): { ok: true; predicate: Record<string, unknown> } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "predicate должен быть объектом-условием (как у wait_for)." };
  const p = { ...(raw as Record<string, unknown>) };
  const kind = p.kind;
  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const scalar = (v: unknown): v is string | number | boolean =>
    typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  // Ревью фиксов Волны 3 (#9): gone не-булевым («gone:"true"») давал ПОЛУмёртвый предикат — одна ветка
  // клиента брала truthy-строку, другая строгий ===true. Тип проверяем на постановке для всех kind.
  if (p.gone !== undefined && typeof p.gone !== "boolean") {
    return { ok: false, reason: "predicate: gone должен быть булевым true/false." };
  }
  switch (kind) {
    case "window":
      if (!s(p.titleContains) && !s(p.process)) return { ok: false, reason: "predicate window: нужен titleContains и/или process." };
      return { ok: true, predicate: p };
    case "ui":
      if (!s(p.role)) return { ok: false, reason: "predicate ui: нужен role." };
      return { ok: true, predicate: p };
    case "text":
      if (!s(p.text)) return { ok: false, reason: "predicate text: нужен непустой text." };
      return { ok: true, predicate: p };
    case "sound":
      if (typeof p.playing !== "boolean") return { ok: false, reason: "predicate sound: нужен playing (true/false)." };
      return { ok: true, predicate: p };
    case "gsi": {
      if (!s(p.path)) return { ok: false, reason: "predicate gsi: нужен path (точка в JSON, напр. «map.game_state»)." };
      // Ревью фиксов (#9): критерий НОРМАЛИЗУЕМ к строке на постановке — клиент сравнивает
      // String(value) со строкой, и boolean/number-критерий (естественный для GSI-JSON:
      // {equals:true}) иначе не матчился бы никогда — тот же класс «мёртвый предикат принят»,
      // что и опечатка в kind. Не-скаляр (объект/массив) — честный отказ.
      if (p.equals !== undefined) {
        if (!scalar(p.equals)) return { ok: false, reason: "predicate gsi: equals должен быть строкой/числом/булевым." };
        p.equals = String(p.equals);
      }
      if (p.contains !== undefined) {
        if (!scalar(p.contains)) return { ok: false, reason: "predicate gsi: contains должен быть строкой/числом." };
        p.contains = String(p.contains);
      }
      return { ok: true, predicate: p };
    }
    case "browser": {
      // fix 2026-07-15: значение из DOM вкладки (video.currentTime и т.п.) — оценивается серверно через ext.
      if (p.value === undefined || !scalar(p.value)) {
        return { ok: false, reason: "predicate browser: нужен value (строка/число/булево — напр. секунды для currentTime)." };
      }
      const validOps = [">=", "<=", ">", "<", "==", "!=", "contains"];
      if (p.op !== undefined && (typeof p.op !== "string" || !validOps.includes(p.op))) {
        return { ok: false, reason: "predicate browser: op должен быть одним из >= <= > < == != contains." };
      }
      return { ok: true, predicate: p };
    }
    default:
      return { ok: false, reason: `predicate: неизвестный kind «${String(kind)}» (ожидается window|ui|text|sound|gsi|browser).` };
  }
}

export function watchCreate(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  if (!ctx.watch || !ctx.sessionId) return err("Наблюдение сейчас недоступно (нет канала озвучки).");
  const what = String(input.what ?? "").trim();
  const condition = String(input.condition ?? "").trim();
  if (!what || !condition) return err("watch_create: нужны и what (что отслеживать), и condition (при каком условии уведомить).");
  // §Волна3 (3.4): локальный предикат (форма wait_for.condition) — проверка на КЛИЕНТЕ ($0, каждые
  // ~5с), без LLM-чекера. §Волна3 ревью (#12): валидируем ПО СТРУКТУРЕ — мёртвый предикат не примется
  // «в тишину» (иначе наблюдение тикало бы вечно, а уведомление было бы невозможно).
  const rawPredicate = input.predicate;
  let predicate: object | undefined;
  if (rawPredicate !== undefined) {
    const v = validatePredicate(rawPredicate);
    if (!v.ok) return err(`watch_create: ${v.reason}`);
    predicate = v.predicate; // нормализованная копия (#9: gsi-критерий коэрсирован к строке)
  }
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

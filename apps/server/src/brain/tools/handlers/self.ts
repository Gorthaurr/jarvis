/**
 * Инструменты САМОУЛУЧШЕНИЯ (волна I, 2026-08-31): «пойми свой код, свои слабости, почини себя».
 *
 * Слой тонкий по замыслу: механика живёт в `self/repo|weaknesses|patch|verify`, здесь — только гейты
 * и формулировки. Два гейта обязательны и стоят именно тут, а не в механике:
 *  • killswitch («полный стоп») замораживает ВЕСЬ цикл правки — включая уже открытую;
 *  • применение правки (merge в рабочую ветку) требует подтверждения владельца §14: это изменение
 *    того, чем он пользуется, и решать его не автономии.
 * Чтение своего кода и своих слабостей не гейтим — это восприятие, а не действие.
 */
import { autonomyFreeze } from "../../../autonomy/freeze.js";
import { dataPath } from "../../../paths.js";
import { abortSelfPatch, applySelfPatch, beginSelfPatch, commitSelfPatch, loadState, repoStatus, verifySelfPatch } from "../../../self/patch.js";
import { readOwnFile, searchOwnCode, selfRepoRoot } from "../../../self/repo.js";
import { collectWeaknesses } from "../../../self/weaknesses.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, gateDeclined, ok } from "../dispatch-util.js";

/** Слабости из собственной телеметрии. Пусто ≠ «всё хорошо» — формулировки это различают. */
export async function selfWeaknesses(_ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const report = await collectWeaknesses(dataPath("logs"), { days: Number(input.days) || undefined, limit: Number(input.limit) || undefined });
  if (report.unavailable) return ok(`Судить о своих слабостях не по чему: ${report.unavailable}. Это «не знаю», а не «всё в порядке».`);
  const head = `Окно: ${report.windowDays} дн. Задач: ${report.tasks.total}, из них провалено: ${report.tasks.failed}.`;
  if (report.weaknesses.length === 0) return ok(`${head} Повторяющихся отказов в телеметрии не нашёл (единичные случаи не считаю слабостью).`);
  const lines = report.weaknesses.map((w, i) => `${i + 1}. [${w.kind}] ${w.title}${w.samples.length ? ` — напр.: ${w.samples.join(" | ")}` : ""}`);
  return ok(`${head}\nПовторяющиеся слабости:\n${lines.join("\n")}`);
}

/** Поиск по своему коду. */
export async function selfCodeSearch(_ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const pattern = String(input.pattern ?? "").trim();
  if (!pattern) return err("self_code_search: нужен pattern");
  try {
    const { hits, scannedFiles, capped } = await searchOwnCode(pattern, { dir: input.dir ? String(input.dir) : undefined, maxHits: Number(input.maxHits) || undefined });
    if (hits.length === 0) return ok(`В своём коде совпадений «${pattern}» не нашёл (просмотрено файлов: ${scannedFiles}).`);
    const lines = hits.map((h) => `${h.path}:${h.line}: ${h.text}`);
    return ok(`Совпадений: ${hits.length}${capped ? " (показаны не все — уточни запрос или каталог)" : ""}, файлов просмотрено ${scannedFiles}.\n${lines.join("\n")}`);
  } catch (e) {
    return err(`self_code_search: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Чтение своего файла окном строк. */
export async function selfCodeRead(_ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const path = String(input.path ?? "").trim();
  if (!path) return err("self_code_read: нужен path (относительно корня репозитория)");
  try {
    const file = await readOwnFile(path, { from: Number(input.from) || undefined, limit: Number(input.limit) || undefined });
    const from = Math.max(1, Number(input.from) || 1);
    const body = file.lines.map((l, i) => `${from + i}\t${l}`).join("\n");
    const tail = file.truncated ? `\n… файл длиннее (${file.totalLines} строк) — читай дальше через from.` : "";
    return ok(`${file.path} (строк всего ${file.totalLines}):\n${body}${tail}`);
  } catch (e) {
    return err(`self_code_read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Человекочитаемое «где я сейчас» по циклу правки. */
async function patchStatusText(): Promise<string> {
  const state = await loadState();
  const status = await repoStatus();
  const where = `Репозиторий: ${selfRepoRoot()}; ветка ${status.branch}${status.dirty ? `, незакоммичено файлов: ${status.changedFiles.length}` : ", дерево чистое"}.`;
  if (!state) return `${where} Открытой самоправки нет.`;
  const v = state.lastVerify ? ` Последняя проверка: ${state.lastVerify.ok ? "зелёная" : "красная"} (${state.lastVerify.summary}).` : " Проверок ещё не было.";
  return `${where} Открыта правка «${state.title}» в ветке ${state.branch}, стадия ${state.stage}.${v}`;
}

/** Цикл самоправки. */
export async function selfPatch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const action = String(input.action ?? "").trim();
  if (action === "status") return ok(await patchStatusText());

  // Killswitch: «полный стоп» обязан останавливать и самоправку — это самая автономная вещь, что я делаю.
  const frozen = autonomyFreeze().info();
  if (frozen) return err(`Автономия остановлена (${frozen.reason}). Себя не правлю, пока не скажете «включи автономию».`);

  try {
    switch (action) {
      case "begin": {
        const title = String(input.title ?? "").trim();
        if (!title) return err("self_patch begin: нужна title (тема правки)");
        const today = new Date().toISOString().slice(0, 10);
        const r = await beginSelfPatch(title, today);
        return r.ok ? ok(r.message) : err(r.message);
      }
      case "verify": {
        // Прогон компилятора и тестов идёт минутами ВНЕШНИМ процессом. Это ожидание, а не моя работа:
        // отдаём его как idleWaitMs — иначе честная проверка съедала бы потолок задачи и правка гибла
        // ровно на шаге, который делает её безопасной (тот же приём, что у блокирующего wait_for).
        const startedAt = Date.now();
        const r = await verifySelfPatch();
        const idleWaitMs = Date.now() - startedAt;
        // Красная проверка — не сбой инструмента, а честный результат: он и должен остановить доклад «починил».
        const res = r.ok ? ok(r.message) : ok(`${r.message} Правку предлагать не буду, пока не станет зелено.`);
        return { ...res, idleWaitMs };
      }
      case "commit": {
        const r = await commitSelfPatch(String(input.message ?? ""));
        return r.ok ? ok(r.message) : err(r.message);
      }
      case "apply": {
        const state = await loadState();
        if (!state) return err("Открытой правки нет — применять нечего.");
        if (state.stage !== "committed") return err("Правка не зафиксирована (нужны verify и commit) — применять нечего.");
        if (!ctx.confirm) return err("Применение правки требует вашего подтверждения, а канал подтверждения недоступен.");
        const summary =
          `Применить мою правку «${state.title}» к рабочей ветке ${state.baseBranch}?\n` +
          `Ветка: ${state.branch}. Проверки: ${state.lastVerify?.summary ?? "нет данных"}.\n` +
          `После применения меня нужно перезапустить.`;
        const c = await ctx.confirm(summary, "irreversible");
        if (!c.approved) {
          const text =
            c.outcome === "undelivered"
              ? `Не стал применять правку «${state.title}» — не смог спросить вас: связь с экраном была недоступна. Работа цела в ветке ${state.branch}.`
              : c.outcome === "expired"
                ? `Не стал применять правку «${state.title}» — вы не ответили. Работа цела в ветке ${state.branch}.`
                : `Не применяю правку «${state.title}» — вы не подтвердили. Работа цела в ветке ${state.branch}.`;
          return gateDeclined(text, c.outcome);
        }
        const r = await applySelfPatch();
        return r.ok ? ok(r.message) : err(r.message);
      }
      case "abort": {
        const r = await abortSelfPatch(input.discard === true);
        return r.ok ? ok(r.message) : err(r.message);
      }
      default:
        return err(`self_patch: неизвестное действие «${action}» (status|begin|verify|commit|apply|abort)`);
    }
  } catch (e) {
    return err(`self_patch ${action}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

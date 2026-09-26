/**
 * W1: исход browser_batch по ответу расширения (закон 1: ушло / не ушло / неизвестно) — отдельно от хендлера.
 *
 * Расширение (modules/batch-plan.js) стопит берст после шага, увёдшего страницу (navigated), отправившего форму
 * (submitted) или с неподтверждённым исходом (uncertain); исход ПОСЛЕДНЕГО шага отдаёт в `results` как есть. Раньше
 * сервер results не читал: «Берст выполнен: n из n» без uncertain, хотя последний клик увёл страницу посреди действия.
 * Журнал чекпойнта получает ту же правду: шаг, чьё действие ушло с неизвестным исходом, — не «сделан» и не «ошибка».
 */
import type { ToolResult } from "../dispatch.js";
import { ok } from "../dispatch-util.js";
import { type ActReply, navigatedTo } from "./browser-act-outcome.js";
import { UNKNOWN_TAIL, batchStopped, unknownOutcome } from "./browser-failure.js";

/** Ответ tab.batch: {ok, done, total, stoppedAt?, code?, error?, results:[{step, ok, intent, result|error}]}. */
export interface BatchReply {
  ok?: boolean;
  done?: number;
  total?: number;
  stoppedAt?: number;
  error?: string;
  code?: string;
  results?: unknown;
}

/** Исход последнего шага из results (форма tabBatch расширения). */
function lastStepResult(results: unknown): ActReply | undefined {
  const last: unknown = Array.isArray(results) ? results[results.length - 1] : undefined;
  const r = last && typeof last === "object" ? (last as { result?: unknown }).result : undefined;
  return r && typeof r === "object" ? (r as ActReply) : undefined;
}

/** Действие шага ушло, исход неизвестен → журнал: «шаги 1..k выполнены; шаг k+1 УШЁЛ — сверь» (не повторит вслепую). */
function markInjected(out: ToolResult, confirmed: number): ToolResult {
  out.partialInjected = true;
  if (confirmed > 0) out.partialSteps = confirmed;
  return out;
}

/** Ответ расширения на берст → ToolResult. `steps` — сколько шагов отправили (если расширение total не вернуло). */
export function batchOutcome(r: BatchReply | undefined, steps: number): ToolResult {
  const done = r?.done ?? 0;
  const total = r?.total ?? steps;
  if (r?.ok) {
    const last = lastStepResult(r.results);
    // srv-tests-5 / EXT-6: последний шаг ушёл, а страница перешла посреди действия — «выполнен» было бы ложью.
    if (last?.uncertain === true) {
      return markInjected(unknownOutcome(`browser_batch: выполнено ${done} из ${total}, но исход последнего шага не подтверждён (страница перешла во время действия). ${UNKNOWN_TAIL}`), done - 1);
    }
    const nav = last && navigatedTo(last) ? " Последний шаг увёл страницу на другой адрес." : "";
    // Успех берста НЕ снимает verify-долг (observed не ставим): ИСХОД (логин прошёл? поиск нашёл?) — отдельная сверка.
    return ok(`Берст выполнен: ${done} из ${total} шагов по ref.${nav} Сверь ИСХОД (browser_inspect/browser_read) прежде чем говорить «готово».`);
  }
  const at = r?.stoppedAt !== undefined ? ` (стоп на шаге ${(r.stoppedAt ?? 0) + 1})` : "";
  const out = batchStopped(r, `browser_batch: выполнено ${done} из ${total}${at}`);
  // Исход шага неизвестен: uncertain-стоп расширение засчитало в done (batch-plan.js), frame_gone (исключение шага) — нет.
  if (out.uncertain === true) return markInjected(out, r?.code === "uncertain" ? done - 1 : done);
  // Контроль-8: частичное исполнение — в журнал («доделай» не повторит уже введённое/нажатое).
  if (done > 0) out.partialSteps = done;
  return out;
}

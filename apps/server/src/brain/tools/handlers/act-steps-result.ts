/**
 * W2 (П4): ИТОГ серии act{steps} — «k из n», причина стопа, ВСЕ флаги честности шага-стопа наружу, ≤ 2 картинки.
 *
 * Серия — одна процедура для петли и журнала (как input_batch): провал шага k+1 при k исполненных → `partialSteps=k`
 * («ЧАСТИЧНО — шаги 1..k УЖЕ ВЫПОЛНЕНЫ»), ушедшее действие шага-стопа (uncertain) → `partialInjected` («СВЕРЬ перед
 * повтором»), вуаль → `overlayDenied` с числом сделанных шагов, §14-отказ → `declined`. Не всё исполнено → ошибка
 * (кроме отказа §14 — как у одиночного вызова), иначе петля засчитала бы серию сделанным делом.
 * Картинки: в сессии подписки прореживание старых кадров не работает, поэтому на серию — не больше двух ПОСЛЕДНИХ
 * кадров с меткой «кадр <id> (шаг k)»; остальные — текстом.
 */
import type { ToolResultContent } from "../../../integrations/llm.js";
import type { ToolResult } from "../dispatch.js";

export const MAX_SERIES_IMAGES = 2;

/** Почему серия остановилась до конца. */
export type StopReason = "error" | "uncertain" | "declined" | "overlay" | "channel" | "veiled" | "cancelled" | "budget";

const REASON_TEXT: Record<StopReason, string> = {
  error: "шаг не удался",
  uncertain: "исход шага НЕИЗВЕСТЕН — действие могло уйти; сверь состояние, не повторяй вслепую",
  declined: "владелец не подтвердил необратимое действие (§14)",
  overlay: "поверх экрана вуаль режима выделения — ввод не идёт",
  channel: "канал с ПК оборвался",
  veiled: "кадр снят ПОД вуалью режима выделения — дальше действовать нельзя",
  cancelled: "задачу отменили",
  budget: "бюджет серии (~180 с) исчерпан",
};

/** Шаг-стоп серии: исход → причина (null — идём дальше). `unchecked`/`met` у act — не стоп. */
export function stopReasonOf(r: ToolResult): StopReason | null {
  if (r.channelDown) return "channel";
  if (r.overlayDenied) return "overlay";
  if (r.veiled) return "veiled";
  if (r.declined) return "declined";
  if (r.uncertain) return "uncertain";
  return r.isError ? "error" : null;
}

export interface StepRecord {
  /** «3/5 act type «Поиск»» — из входа МОДЕЛИ (не с экрана). */
  label: string;
  r: ToolResult;
  /** Мутация (act не hover/scroll) — для `observed`. */
  mutate: boolean;
  capture: boolean;
}

const textOf = (c: ToolResult["content"]): ToolResultContent[] => (typeof c === "string" ? [{ type: "text", text: c }] : c);

/** Блоки всех шагов: картинки сверх лимита (с начала) → текст; у оставленных — метка кадра. */
function stepBlocks(steps: readonly StepRecord[]): ToolResultContent[] {
  const imageSteps = steps.flatMap((s, i) => (textOf(s.r.content).some((b) => b.type === "image") ? [i] : []));
  const keep = new Set(imageSteps.slice(-MAX_SERIES_IMAGES));
  const out: ToolResultContent[] = [];
  steps.forEach((s, i) => {
    out.push({ type: "text", text: `── шаг ${s.label} ──` });
    for (const b of textOf(s.r.content)) {
      if (b.type !== "image") out.push(b);
      else if (keep.has(i)) {
        const frame = (s.r.data as { frameId?: unknown } | undefined)?.frameId;
        out.push({ type: "text", text: `[кадр ${typeof frame === "string" ? frame : "без id"} (шаг ${i + 1})]` }, b);
      } else out.push({ type: "text", text: `[кадр шага ${i + 1} не приложен: на серию — не больше ${MAX_SERIES_IMAGES} картинок; нужен — отдельный screen_capture]` });
    }
  });
  return out;
}

/**
 * Итог серии. `steps` — исполненные шаги (последний — шаг-стоп, если `stop` про него); `n` — сколько было в серии.
 * `stop` без шага-исполнителя (отмена, бюджет) — стоп ДО очередного шага.
 */
export function seriesResult(steps: readonly StepRecord[], n: number, stop: StopReason | null, idleWaitMs: number): ToolResult {
  const stepStopped = stop !== null && stop !== "cancelled" && stop !== "budget";
  const done = stepStopped ? steps.length - 1 : steps.length;
  const head = stop
    ? `act{steps}: СТОП — выполнено ${done} из ${n}; остальные шаги НЕ исполнялись. Причина: ${REASON_TEXT[stop]}.`
    : `act{steps}: выполнено ${n} из ${n} шагов.`;
  const content = [{ type: "text" as const, text: head }, ...stepBlocks(steps)];
  const out: ToolResult = { content, isError: stop !== null && stop !== "declined", data: { done, total: n, ...(stop ? { stop } : {}) } };
  if (idleWaitMs > 0) out.idleWaitMs = idleWaitMs;
  if (steps.some((s) => s.r.sent === true)) out.sent = true;
  const last = steps.at(-1)?.r;
  if (done > 0 && stop) out.partialSteps = done;
  if (stop === "declined") out.declined = true;
  if (stop === "channel") out.channelDown = true;
  if (stop === "uncertain" || (stepStopped && last?.partialInjected)) {
    out.uncertain = true;
    out.partialInjected = true;
  }
  if (stop === "overlay" || stop === "veiled") {
    // Вуаль остановила ПРОЦЕДУРУ: петля не считает это провалом модели и называет сделанные шаги.
    out.overlayDenied = true;
    out.overlayProcedure = true;
    out.overlayStepIndex = done;
    if (stop === "veiled") out.veiled = true;
    if (last?.overlayActionInjected) out.overlayActionInjected = true;
  }
  if (!stop) {
    // Сверка — после ПОСЛЕДНЕЙ мутации: кадр (не под вуалью, не пустой) или собственная сверка шага (met/сильная дельта).
    const li = steps.map((s) => s.mutate).lastIndexOf(true);
    const seen = steps.slice(li + 1).some((s) => s.capture && !s.r.isError && s.r.empty !== true);
    out.observed = (li >= 0 && steps[li]!.r.observed === true) || seen;
  }
  return out;
}

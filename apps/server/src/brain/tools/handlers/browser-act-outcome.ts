/**
 * W1: что значит ответ расширения на browser_act для verify-долга (закон 1) — отдельно от хендлера.
 *
 * Долг сверки снимает только СИЛЬНЫЙ сигнал состояния цели: readback значения/галочки поля (type/set/select),
 * позиция/состояние плеера (медиа-интенты), достоверный переход. Слабые (changed:true, «похоже перешла») — нет.
 * Жест ОТПРАВКИ (Enter/submit/type+enter/key Enter) наблюдением поля долг не снимает: исход отправки сверяется
 * отдельно. Старое расширение `submitted` у key не возвращает — поэтому жест распознаём и по самому вызову.
 */
import { isCommitKeyCombo } from "@jarvis/shared";
import type { ToolResult } from "../dispatch.js";
import { err } from "../dispatch-util.js";

export interface ActReply {
  navigated?: unknown;
  uncertain?: boolean;
  playing?: boolean;
  currentTime?: number;
  value?: unknown;
  checked?: unknown;
  submitted?: boolean;
}

const HISTORY_INTENTS: ReadonlySet<string> = new Set(["back", "forward"]);

const truthy = (v: unknown): boolean => v === true || v === "true" || v === 1 || v === "1";

/** Переход состоялся: navigated:true (новое расширение) или адрес строкой (старое). false/"" — перехода не было. */
export function navigatedTo(r: ActReply): boolean {
  return r.navigated === true || (typeof r.navigated === "string" && r.navigated.length > 0);
}

/** Жест отправки: расширение сказало submitted, либо сам вызов — Enter/submit/type+enter/key Enter (пустой combo = Enter). */
export function actCommits(intent: string, params: Record<string, unknown>, r: ActReply): boolean {
  if (r.submitted === true || intent === "enter" || intent === "submit") return true;
  if (intent === "type") return truthy(params.enter) || truthy(params.submit);
  if (intent === "key") {
    const combo = String(params.combo ?? params.key ?? "").trim();
    return combo === "" || isCommitKeyCombo(combo);
  }
  return false;
}

/** Сильный сигнал исхода → `observed` (verify-долг снят в том же раунде). */
export function actObserved(intent: string, params: Record<string, unknown>, r: ActReply): boolean {
  const readback = (r.value !== undefined || r.checked !== undefined) && !actCommits(intent, params, r);
  const media = !HISTORY_INTENTS.has(intent) && (r.playing !== undefined || r.currentTime !== undefined);
  return readback || media || (navigatedTo(r) && r.uncertain !== true);
}

/**
 * B-6 (старое расширение): back/forward на странице с видео перематывали плеер ±10 с и отвечали позицией — это НЕ
 * переход по истории. Раньше сервер писал «Сделал back» и снимал долг (позиция плеера = «сильный сигнал»).
 */
export function historySeekMismatch(intent: string, r: ActReply): ToolResult | null {
  if (!HISTORY_INTENTS.has(intent) || r.navigated !== undefined) return null;
  if (r.currentTime === undefined && r.playing === undefined) return null;
  return err(
    `browser_act «${intent}»: расширение старой версии перемотало видео вместо перехода по истории — «${intent === "back" ? "назад" : "вперёд"}» ` +
      `НЕ сделан. Обнови расширение («Обновить» в chrome://extensions); перемотка ролика — intent "seek".`,
  );
}

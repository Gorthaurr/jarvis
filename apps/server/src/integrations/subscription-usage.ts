/**
 * usage хода на подписке из потока SDK (вынесено из subscription-session.ts, A5 аудита 27.09).
 *
 * 🔴 Живой дефект: outputTokens на подписке были занижены в 10–100 раз (неделя 21–27.09: медиана 3, max 33 —
 * на монологах из нескольких фраз). SDK шлёт КАЖДЫЙ блок ответа отдельным assistant-кадром со СНИМКОМ usage
 * начала сообщения (message_start: output ≈ 1), а итог вывода (включая thinking) приходит только в
 * stream_event `message_delta.usage.output_tokens`. Сессия засчитывала первый снимок и итог теряла — слепли
 * metrics.jsonl, часовой гард трат, самоанализ и юнит-экономика.
 *
 * Правило: вход/кеш — из снимка ЭТОГО вызова API (per-call, так гард контекст-окна видит реальный промпт);
 * вывод — наибольший из увиденных для того же ответа (message_delta — кумулятив по сообщению, не по сессии).
 */
import type { SessionUsage } from "./subscription-session.js";

/** usage ассистентского сообщения SDK → наш формат (per-call, не кумулятив). */
export function readUsage(u: Record<string, unknown> | undefined): SessionUsage | undefined {
  if (!u) return undefined;
  const n = (k: string) => {
    const v = Number(u[k]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const out = { inputTokens: n("input_tokens"), outputTokens: n("output_tokens"), cacheReadTokens: n("cache_read_input_tokens"), cacheCreationTokens: n("cache_creation_input_tokens") };
  return out.inputTokens + out.outputTokens + out.cacheReadTokens + out.cacheCreationTokens > 0 ? out : undefined;
}

/**
 * assistant-кадр: НОВЫЙ ответ (другой id, или id нет) — его снимок целиком; тот же ответ — вход не трогаем
 * (каждый блок несёт тот же снимок, считаем ОДИН раз), вывод — больший из увиденных.
 */
export function mergeFrameUsage(prev: SessionUsage | undefined, prevId: string | undefined, id: string | undefined, next: SessionUsage | undefined): SessionUsage | undefined {
  if (!next) return prev;
  if (!prev || !id || id !== prevId) return next;
  return next.outputTokens > prev.outputTokens ? { ...prev, outputTokens: next.outputTokens } : prev;
}

/**
 * stream_event `message_delta` → итог вывода ТЕКУЩЕГО ответа. Учитываем, только если снимок этого ответа уже
 * есть: иначе запоздалое событие прошлого ответа (после страховочного таймера) легло бы в следующий ход.
 */
export function withStreamOutput(prev: SessionUsage | undefined, event: unknown): SessionUsage | undefined {
  const out = Number((event as { usage?: { output_tokens?: unknown } } | undefined)?.usage?.output_tokens);
  if (!prev || !Number.isFinite(out) || out <= prev.outputTokens) return prev;
  return { ...prev, outputTokens: out };
}

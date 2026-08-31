/**
 * ПРОВЕРКА ФАКТА ДОСТАВКИ ПЕРЕД ПОВТОРОМ (2026-08-31, живой эпизод «Катя получила дубль»).
 *
 * 🔴 Корень дефекта: у отправки человеку ТРИ исхода, а код знал два. `telegram.send` возвращал
 * `ok:false` и когда сообщение НЕ ушло, и когда оно УШЛО, но подтверждение потерялось (истёк
 * таймаут действия, CDP-вкладка ответила позже, пузырь не успел отрисоваться за 1.3с проверки).
 * Дальше срабатывал фолбэк на расширение — ВТОРОЙ отправитель по тому же аккаунту — и человек
 * получал одно и то же дважды. Идемпотентность по тексту не спасала: ключ ставится только на
 * `result.ok`, то есть ровно в неопределённом случае его и не было.
 *
 * Механика: неопределённый исход НЕ повторяем вслепую — сперва ЧИТАЕМ чат и смотрим, есть ли там
 * наше исходящее. Три честных вердикта:
 *  • `delivered` — своё сообщение видно в ленте: докладываем УСПЕХ (он и был), повтор не нужен;
 *  • `absent` — чат открылся, нашего сообщения нет: сообщение не ушло, фолбэк законен;
 *  • `unknown` — прочитать не удалось (канал/резолв/формат): НЕ знаем. Отправлять второй раз
 *    в этом состоянии нельзя (дубль необратим), молчать «отправлено» — тоже (ложный успех).
 *
 * Асимметрия цены осознанная: ложное «delivered» = молчаливая потеря сообщения, ложное `absent` =
 * дубль живому человеку. Поэтому совпадение текста СТРОГОЕ (точное или вхождение достаточно
 * длинной строки целиком), а любая неуверенность чтения — `unknown`, не `absent`.
 */
import { normalizeSendBody } from "./resend-guard.js";

/** Сообщение чата в том виде, в каком его отдаёт актуатор (`telegram.read`). */
export interface ChatMessage {
  /** Направление: "out" — наше исходящее. */
  dir?: unknown;
  text?: unknown;
}

export type DeliveryVerdict = "delivered" | "absent" | "unknown";

/**
 * Ниже этой длины нормализованный текст сравнивается ТОЛЬКО целиком: короткое «да»/«ок» как
 * подстрока нашлось бы в любом соседнем исходящем («да, конечно») и дало бы ложное «доставлено».
 */
const SUBSTRING_MIN_CHARS = 12;

/** Видно ли НАШЕ исходящее сообщение среди последних сообщений чата. */
export function findOwnMessage(messages: readonly ChatMessage[] | undefined, body: string): boolean {
  const want = normalizeSendBody(String(body ?? ""));
  if (!want) return false;
  for (const m of messages ?? []) {
    if (m?.dir !== "out") continue;
    const got = normalizeSendBody(String(m.text ?? ""));
    if (!got) continue;
    if (got === want) return true;
    // Пузырь может нести хвост мета-текста, который чистка не сняла → вхождение целиком тоже
    // считаем доставкой, но лишь для достаточно длинного (значит различающего) текста.
    if (want.length >= SUBSTRING_MIN_CHARS && got.includes(want)) return true;
  }
  return false;
}

/** Результат чтения чата для сверки (то, что приходит от актуатора). */
export interface ChatReadback {
  ok: boolean;
  messages?: unknown;
}

/**
 * Вердикт по прочитанному. Формат не распознан (чтение не вышло / messages не массив) → `unknown`:
 * «не смог посмотреть» ≠ «сообщения нет» — та же грабля, что у слепой вкладки в наблюдениях.
 */
export function verdictFromReadback(readback: ChatReadback | undefined, body: string): DeliveryVerdict {
  if (!readback?.ok) return "unknown";
  const messages = readback.messages;
  if (!Array.isArray(messages)) return "unknown";
  return findOwnMessage(messages as ChatMessage[], body) ? "delivered" : "absent";
}

/**
 * Прочитать чат и вынести вердикт. `read` бросил/не ответил → `unknown` (никогда не «не ушло»).
 */
export async function probeDelivery(body: string, read: () => Promise<ChatReadback>): Promise<DeliveryVerdict> {
  try {
    return verdictFromReadback(await read(), body);
  } catch {
    return "unknown";
  }
}

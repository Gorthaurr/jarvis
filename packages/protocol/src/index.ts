/**
 * @jarvis/protocol — центральный шов клиент↔сервер (§5, §6).
 *
 * Brain эмитит абстрактные ActionCommand; клиент мапит их на актуаторы.
 * Никаких знаний о SendInput/puppeteer/nut.js здесь нет — только контракт.
 */
export * from "./constants.js";
export * from "./actions.js";
export * from "./messages.js";

import { PROTOCOL_VERSION } from "./constants.js";
import type { Envelope, MessageType } from "./messages.js";

let counter = 0;

/**
 * Собрать конверт. id — uuid (через crypto, если доступен), иначе монотонный fallback.
 * ts проставляет вызывающий слой (Date.now недоступен в части окружений) или now.
 */
export function makeEnvelope<T>(type: MessageType, payload: T, id?: string, ts?: number): Envelope<T> {
  return {
    id: id ?? newId(),
    ts: ts ?? Date.now(),
    type,
    payload,
  };
}

/** uuid v4, если есть crypto.randomUUID; иначе детерминированный fallback для dev. */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  counter += 1;
  return `id-${counter.toString(36)}-${Math.trunc(performance.now?.() ?? 0).toString(36)}`;
}

/** Грубая структурная проверка конверта (валидация полей — на слое gateway). */
export function isEnvelope(v: unknown): v is Envelope {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Envelope).id === "string" &&
    typeof (v as Envelope).type === "string" &&
    "payload" in (v as Envelope)
  );
}

/** Совместимы ли мажоры протокола (§5: несовпадение → ошибка, не тихий рассинхрон). */
export function isProtocolCompatible(clientVersion: number): boolean {
  return clientVersion === PROTOCOL_VERSION;
}

/**
 * Служебные фразы ПРОМОУШЕНА (sync-first ушёл в фон): ротация ack задачи с моделью и ack быстрого пути tier0.
 * Вынесены из agent/index.ts (W3): их же прогревает кеш TTS на старте сессии (V-5, gateway/router-ws.ts) —
 * повторный синтез одной и той же фразы стоил ~180 мс на КАЖДЫЙ ход с руками.
 */
import { verbalize } from "../verbalize/index.js";

/** Короткие ack промоушена — ротация, чтобы не было заученной отбивки (персона: «variety is mandatory»). */
export const PROMOTE_ACKS = ["Берусь, сэр.", "Сию минуту.", "Занимаюсь.", "Сейчас сделаю.", "Принял, делаю.", "Есть, сэр."] as const;

/** tier0 «открой X» затянулся — ack быстрого пути (итог прозвучит по готовности). */
export const TIER0_PROMOTE_ACK = "Секунду, сэр.";

let promoteAckIdx = 0;

/** Следующий ack ротации — уже вербализованный: РОВНО эта строка уходит в синтез (и в прогрев кеша). */
export function promoteAck(): string {
  const ack = PROMOTE_ACKS[promoteAckIdx % PROMOTE_ACKS.length]!;
  promoteAckIdx += 1;
  return verbalize(ack);
}

/** Все служебные ack в той форме, в какой их синтезирует пайплайн (verbalize + trim) — для прогрева кеша TTS. */
export function ackPhrasesForTts(): string[] {
  return [...PROMOTE_ACKS, TIER0_PROMOTE_ACK].map((a) => verbalize(a).trim());
}

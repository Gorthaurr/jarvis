/**
 * Как озвучить СПАСЁННУЮ реплику отменённого хода (salvage, pipeline.salvageCancelledReply) — таблица решений.
 *
 * Текст спасённой реплики уходит в чат всегда; здесь решается только ГОЛОС:
 *  - владелец велел молчать («стоп»/«заткнись»/mute) → не озвучиваем никогда (запрещённое не воскресает);
 *  - речь уже частично прозвучала (перебили на середине) → не повторяем целиком: barge-in = «хватит»;
 *  - служебный ack промоушена («Берусь, сэр») → не озвучиваем: владелец уже дал новую команду, «Берусь»
 *    устарел, а итог задачи придёт сам (speakResult с answerOf). Ревью р1 (аудит 27.09): ack спасался как ответ —
 *    звучал поверх полного экрана, открывал окно разговора (T-F6) и закрывал first_answer на «Берусь»;
 *  - done() с origin proactive или ход, принятый ОКНОМ без «Джарвис» (viaWake=false: фильм/комната) → проактив:
 *    busy-гейт держит, окна не открывает. Ревью р1: иначе цепочка фраз фильма сама продлевала окно (P1 A2);
 *  - адресованный ход → ответ владельцу (origin user-turn, A3): busy-гейт не держит — он ждёт именно этот ответ.
 *    answerOf НЕ ставим: first_answer спасённого ответа мерил бы длину перебившего хода, а не мозга, и путь
 *    "promoted" (итог фоновой задачи) солгал бы. Потеря метрики видна — salvage логирует ход (turn).
 */
import type { SpeechOrigin } from "./pipeline.js";

export interface SalvageInput {
  /** Владелец велел молчать после начала хода. */
  silenced: boolean;
  /** Часть реплики уже прозвучала. */
  spokeAlready: boolean;
  /** Ход адресован владельцем (meta.viaWake !== false). */
  addressed: boolean;
  /** opts done(): служебный ack промоушена / происхождение реплики. */
  ack?: boolean;
  origin?: SpeechOrigin;
}

export type SalvagePlan = { voice: false; reason: string } | { voice: true; origin: SpeechOrigin };

export function planSalvage(i: SalvageInput): SalvagePlan {
  if (i.silenced) return { voice: false, reason: "владелец попросил молчать" };
  if (i.spokeAlready) return { voice: false, reason: "речь уже частично прозвучала" };
  if (i.ack) return { voice: false, reason: "служебный ack промоушена — итог задачи прозвучит сам" };
  if (i.origin === "proactive" || !i.addressed) return { voice: true, origin: "proactive" };
  return { voice: true, origin: "user-turn" };
}

/**
 * W2 (пакет 0, решение №1): ЕДИНСТВЕННЫЙ путь мутирующих RPC сайдкара — type, key, click, mouse, invoke.
 *
 * Сюда сходятся dispatch, реплей навыка (input_batch/skill_execute/авто-макрос) и SDK-мост: рубеж (self → secret →
 * commit, injection-guard.ts) судит КАЖДУЮ инжекцию, а не точку входа команды (раньше §14 стоял в dispatchTool
 * сервера и в обёртке моста, а реплей и act ходили мимо).
 * Порядок в вызывающих: сперва гейт вуали (DrawingOverlayError — состояние системы, первым), затем injectRpc.
 * Прямой `sidecar().request` для мутаций запрещён; осознанное исключение одно — `releaseHeldPointer` (input.ts):
 * отпустить НАШУ же зажатую кнопку при закрытии вуали — не новое действие, а снятие незавершённого.
 */
import type { InjectOp } from "@jarvis/shared";
import { guardInjection } from "./injection-guard.js";
import { noteInjected } from "./injection-journal.js";
import { sidecar } from "./sidecar-client.js";

export type { InjectOp };

export async function injectRpc(op: InjectOp, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  await guardInjection(op, params);
  noteInjected(op, params); // П2: набранное/память клика — только по прошедшему ВСЕХ судей (отказ ничего не меняет)
  // Сигнатура запроса — ровно прежняя (без лишнего undefined-таймаута): тесты и сайдкар видят то же, что до рубежа.
  return timeoutMs === undefined ? sidecar().request(op, params) : sidecar().request(op, params, timeoutMs);
}

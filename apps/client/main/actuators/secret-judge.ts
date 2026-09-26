/**
 * W2 (пакет 0): судья «secret» (§0) рубежа инжекции — ЗАГЛУШКА (null: пропускает). Реализует П2.
 * Луна по inputBuffer.digits(40) + новый текст — всегда; секретное поле (зеркало value «•••», looksLikeSecretField по
 * name/automationId, focused().secret); вставка (PASTE_COMBOS, «Вставить») — clipboardText() и поле в фокусе. Неодобряемо.
 */
import type { Judge } from "./injection-guard.js";

export const secretJudge: Judge = async () => null;

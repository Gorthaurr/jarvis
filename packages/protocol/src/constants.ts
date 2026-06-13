/**
 * Константы протокола и семантики соединения (§5).
 * Несовпадение мажора PROTOCOL_VERSION → сервер отвечает ошибкой,
 * клиент показывает «требуется обновление» (рассинхрон громкий, не тихий).
 */

/** Мажорная версия протокола. Бампить при несовместимых изменениях контракта. */
export const PROTOCOL_VERSION = 1 as const;

/** Heartbeat: ping/pong каждые 15 c; два пропуска подряд → реконнект (§5). */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_MAX_MISSES = 2;

/** Таймаут по умолчанию для ActionCommand, если сервер не задал свой (§5). */
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;

/** Follow-up окно после конца TTS: микрофон горячий без повторного wake word (§10). */
export const FOLLOWUP_WINDOW_MS = 6_000;

/** Цель латентности до первого звука (§10). Метрика, не таймаут. */
export const TARGET_FIRST_AUDIO_MS = 800;

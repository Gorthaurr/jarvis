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

/**
 * Таймаут отправки действия ПО ВИДУ команды. Корень бага «команда не выполнилась, хотя приложение
 * открылось»: серверный синтетический таймаут (15с) короче РЕАЛЬНОГО окна запуска на клиенте — холодный
 * `smartLaunch` (app-resolve.ts) делает Start-Sleep 1.5с + скан App Paths/Steam-манифестов/рекурсию по
 * Пуску, а для uri/steam поллит до 8с; hard-таймаут лаунчера 25с. Сервер успевал отрапортовать timeout,
 * пока клиент ещё (часто успешно) запускал → ЛОЖНЫЙ провал. Таймаут синтетический (session.ts) и unref'нут
 * — поднятие верхней границы happy-path (1-3с) не замедляет и голос не вешает (запуск идёт в фоне).
 */
export function actionTimeoutMs(kind: string): number {
  switch (kind) {
    case "app.launch":
      return 30_000; // холодный резолв + Start-Sleep + поллинг steam/uri; перекрывает hard-25с лаунчера +запас
    case "app.close":
    case "app.focus":
    case "browser.open":
      return 20_000; // close: Start-Sleep 1.2с + скан процессов; focus/open: резолв окна/shell-fallback
    case "wait.for":
      return 130_000; // §Волна2 (2.3): клиентское ожидание — до 120с поллинга + запас на транспорт
    case "screen.ocr":
      return 25_000; // §Волна2 (2.3): захват + OCR в сайдкаре (его внутренний таймаут 20с)
    case "ui.snapshot":
      return 20_000; // §Волна2 (2.4): обход UIA-дерева сложного окна дольше дефолтных 15с
    default:
      return DEFAULT_ACTION_TIMEOUT_MS;
  }
}

/** Follow-up окно после конца TTS: микрофон горячий без повторного wake word (§10). */
export const FOLLOWUP_WINDOW_MS = 6_000;

/** Цель латентности до первого звука (§10). Метрика, не таймаут. */
export const TARGET_FIRST_AUDIO_MS = 800;

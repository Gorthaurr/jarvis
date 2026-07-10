/**
 * Keep-alive MV3 service-worker на время длинной операции — вынесено из god-file background.js (§ревью split).
 * Self-contained (только chrome.runtime). Возвращает clearInterval-хэндл — звать в finally.
 */

/**
 * Держать MV3 service worker ЖИВЫМ во время длинной операции (Telegram-отправка ~15-20с): Chrome
 * убивает SW при простое >30с между событиями → WS к серверу рвётся → запрос отклоняется
 * («расширение не ответило»/«отключилось»). Периодический вызов chrome-API сбрасывает таймер простоя.
 * Возвращает clearInterval-хэндл — звать в finally.
 */
export function startKeepAlive() {
  return setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch { /* ignore */ } }, 15000);
}

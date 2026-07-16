/**
 * Гонка асинхронного опроса с КАПОМ времени (fix OCR-hang, ревью 2026-07-15). Отдельный модуль БЕЗ
 * Electron-зависимостей — чтобы логика капа тестировалась (sensors-cheap тянет сайдкар/захват экрана).
 *
 * Проблема: один опрос wait_for (screenOcr → captureScreen + сайдкар до ~20с) мог блокировать весь
 * бюджет ожидания мимо его timeout (серверный watch получал «нет result за 25000ms»). raceWithCap гонит
 * опрос наперегонки с капом: зависший опрос отдаёт fallback В СРОК, таймер очищается (нет утечки).
 */

/** Жёсткий потолок одного опроса (мс). Кап клампится в [400, PER_POLL_HARD_CAP_MS]. */
export const PER_POLL_HARD_CAP_MS = 4_000;

/**
 * Вернуть результат `fn()` ИЛИ `onTimeout()`, если `fn` не успел за min(budgetMs, cap). Таймер очищается
 * в любом исходе (finally). Проигравший гонку промис `fn` осиротеет и завершится позже (игнорируется) —
 * это осознанный компромисс Promise.race; для редких сенсорных опросов накопления нет.
 */
export function raceWithCap<T>(fn: () => Promise<T>, budgetMs: number, onTimeout: () => T): Promise<T> {
  const cap = Math.max(400, Math.min(PER_POLL_HARD_CAP_MS, budgetMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), cap);
  });
  return Promise.race([fn(), timed]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

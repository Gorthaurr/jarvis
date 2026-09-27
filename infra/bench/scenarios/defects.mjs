// Стенд: известные НАСТОЯЩИЕ дефекты Джарвиса, найденные стендом. Тест остаётся честным (проверяет правильное
// поведение), но помечен `todo` — node --test показывает его как «ждёт фикса W1», прогон не краснеет.
// Починили — удалите запись: тест станет обычным и будет стеречь фикс.
// D2 (двойной вопрос), D4 (Enter после «да») и D7 (двухшаговая сдача) закрыты фиксами раунда 2 W1 — записи удалены.
export const DEFECTS = {
  // apps/extension/background.js runInPage: executeScript РЕЗОЛВИТСЯ без результата, когда клик увёл страницу
  // (POST-форма); ветка «вкладка ушла → navigated+uncertain» стоит только в catch. Итог: оплата ПРОШЛА, а
  // инструмент отвечает «Не вышло «click» на странице» без uncertain — модель повторит клик (двойная оплата).
  NAV_NO_RESULT: "W1-D1: клик, уведший страницу, рапортуется «Не вышло» (исход известен: действие прошло)",
  // brain/tools/handlers/browser-target.ts resolveBrowserTarget: явный url отбрасывает запомненный tabId из browser_open,
  // а extension/modules/tab-find.js ищет по хосту только ЗАКОММИЧЕННЫЙ tab.url (pendingUrl — нет). Сразу после
  // browser_open (страница ещё грузится) browser_inspect{url} → «вкладка … не открыта».
  OPEN_RACE: "W1-D3: browser_inspect{url} сразу после browser_open (навигация не закоммичена) → «вкладка не открыта»",
  // apps/extension/modules/capture.js: chrome.tabs.captureVisibleTab ограничен квотой Chrome (2 вызова/с); третий
  // снимок за секунду (полный кадр → зум → зум, image-чтения одного раунда) падает capture_failed вместо выжидания.
  CAPTURE_QUOTA: "W1-D5: третий browser_read{view:image} за секунду → capture_failed (квота captureVisibleTab 2/с), без выжидания",
  // Корень тот же, что у W1-D2 (подпись ref = name+selector+role+type): у кнопки навигации теста
  // `input[type=submit][name=next]` в «подписи» оказывается слово submit ИЗ СЕЛЕКТОРА И ТИПА → «Следующая страница» и
  // «Закончить попытку...» судятся как сдача — владельцу задают вопрос на каждой странице теста.
  LMS_NAV_ASKS: "W1-D6: навигация по страницам теста Moodle («Следующая страница») спрашивает владельца",
};

/** Опции node:test для теста, который ждёт фикса. */
export const waitsFix = (id) => (DEFECTS[id] ? { todo: `ждёт фикса W1 — ${DEFECTS[id]}`, timeout: 120_000 } : { timeout: 120_000 });

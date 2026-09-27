/**
 * chrome.scripting.executeScript РЕЗОЛВИЛСЯ без результата (W1-D1, стенд): документ, где шла page-функция, выгрузился
 * посреди неё — клик по кнопке POST-формы увёл страницу, а Chrome промис умершего документа не ждёт и исключения не
 * бросает. Раньше это было «Не вышло» с координатным хатчем при ПРОШЕДШЕЙ оплате (модель кликнула бы снова — дубль).
 * Тот же уход, но документ ЗАМОРОЖЕН в back/forward-кэше (27.09, Moodle «Вход»): executeScript не отвечал минутами (мост —
 * isError через 20 с), поэтому robustClickMain сам отвечает по pagehide маркером {pageLeft:true} — сюда же (runInPage).
 * Закон 1 (ушло / не ушло / неизвестно) — исход по месту и по интенту:
 *  • подготовка (before: штамп ref) или целевой фрейм — как смерть контекста (frame-gone.js): «не выполнял» / frame_gone;
 *  • МЕНЯЮЩЕЕ действие в top, вкладка ушла (адрес сменился / грузится) → {ok, navigated, uncertain}: переход есть,
 *    исход действия не подтверждён (сервер не снимает verify-долг);
 *  • МЕНЯЮЩЕЕ, вкладка на прежнем адресе → page_gone: «НЕ ЗНАЮ, сработало ли — сверь» (сервер: uncertain, без хатча);
 *  • чтение / наведение / прокрутка → page_gone: «страница перезагрузилась — повтори» (сервер различает по интенту).
 */
import { contextLost } from "./frame-gone.js";

// Зеркало серверного NON_MUTATING_INTENTS (brain/tools/browser-params.ts): незнакомый интент считается меняющим.
const PAGE_LEFT_SAFE_INTENTS = new Set(["hover", "scroll_to", "scroll", "getValue", "readMedia"]);

export async function pageLeftOutcome(tabId, frameId, before, intent, urlBefore) {
  if (frameId !== undefined || before) return contextLost(frameId, "executeScript без результата", before);
  if (PAGE_LEFT_SAFE_INTENTS.has(String(intent))) {
    return { ok: false, code: "page_gone", error: "страница перезагрузилась во время «" + intent + "» — результата нет. Повтори по свежей странице (browser_inspect / browser_read)." };
  }
  let t = null;
  try {
    t = await chrome.tabs.get(tabId);
  } catch {
    t = null; // вкладку закрыли — исход действия тем более неизвестен
  }
  if (t && (t.status === "loading" || (t.url || "") !== urlBefore)) {
    // Навигация ещё не закоммичена (POST-форма ждёт ответа): url — прежний, КУДА уходит — pendingUrl.
    return { ok: true, navigated: t.pendingUrl || t.url || true, uncertain: true, note: "страница перешла во время действия — исход не подтверждён" };
  }
  return { ok: false, code: "page_gone", error: "страница сменила документ во время «" + intent + "» и результата не вернула — исход неизвестен, действие могло сработать" };
}

/**
 * Медленный POST (ревью р1, 27.09): клик в top отправил форму, а ответ сервера идёт дольше ожидания robustClickMain —
 * документ ещё на месте, контент не менялся ({changed:false}), но вкладка УЖЕ грузится. «Не отреагировала» здесь — ложь:
 * модель кликнула бы снова (двойная отправка). Грузится / есть pendingUrl → переход вероятен, исход не подтверждён.
 */
export async function slowNavOutcome(tabId, frameId, rc, intent) {
  if (intent === "hover" || !rc || rc.ok !== true || rc.changed !== false || rc.navigated || (frameId !== undefined && frameId !== 0) || rc.frame !== undefined) return rc;
  let t = null;
  try { t = await chrome.tabs.get(tabId); } catch { return rc; }
  if (!t || (t.status !== "loading" && !t.pendingUrl)) return rc;
  return { ok: true, navigated: t.pendingUrl || t.url || true, uncertain: true, note: "клик запустил загрузку страницы (ответ сайта ещё идёт) — исход не подтверждён" };
}

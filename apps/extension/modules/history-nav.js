/**
 * back/forward — ВСЕГДА история вкладки (B-6), никогда не перемотка медиа (раньше на странице с видео «назад» мотало
 * на 10 с, а сервер засчитывал это как сверку). chrome.tabs.goBack/goForward + опрос адреса → {ok, navigated, url}.
 * Истории нет → no_history; вкладка закрылась → tab_closed. Адрес не сменился за отведённое время → navigated:false
 * (переход без смены URL или медленная загрузка — честно «не видно перехода», а не «перешёл»). Требует право tabs.
 */
import { codedError, sleep } from "./utils.js";

export async function historyNav(tabId, dir, timeoutMs = 5000) {
  const back = dir === "back";
  let before;
  try {
    before = await chrome.tabs.get(tabId);
  } catch {
    throw codedError("tab_closed", "вкладка " + tabId + " закрыта");
  }
  const urlBefore = (before && before.url) || "";
  try {
    await (back ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/no tab/i.test(msg)) throw codedError("tab_closed", "вкладка " + tabId + " закрыта");
    throw codedError("no_history", (back ? "назад" : "вперёд") + " в истории вкладки некуда");
  }
  let t = before;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(150);
    try {
      t = await chrome.tabs.get(tabId);
    } catch {
      throw codedError("tab_closed", "вкладка закрылась во время перехода");
    }
    if ((t.url || "") !== urlBefore && t.status === "complete") return { ok: true, navigated: true, url: t.url };
  }
  const url = (t && t.url) || urlBefore;
  return { ok: true, navigated: url !== urlBefore, url, ...(t && t.status !== "complete" ? { loading: true } : {}) };
}

/**
 * Поиск/ожидание ЦЕЛЕВОЙ вкладки (SW-уровень) — вынесено из god-file background.js (§ревью split).
 * НЕ page-инжекторы (исполняются в service worker, не в странице) → дробятся свободно. Требует право tabs.
 */
import { codedError, hostOf, noTabError, sleep } from "./utils.js";

/**
 * Найти ЦЕЛЕВУЮ вкладку. Приоритет — tabId из browser_open (точное попадание + лечит гонку
 * about:blank: свежая вкладка ещё без url, по хосту не находится, по id — сразу). Иначе по ХОСТУ
 * (среди совпадений — активная, иначе первая). Хост задан, но вкладки НЕТ → null (НЕ бьём в чужую
 * активную — это и был баг: play/read уходили в Telegram). Ни tabId, ни хоста → активная в окне.
 * W1 (B-9): явный tabId, которого больше НЕТ, → ошибка tab_closed. Раньше молча падали в поиск по хосту/в активную
 * вкладку владельца — действие уходило туда, куда его не просили (наблюдение с recover ловит код и чинит вкладку).
 */
export async function findTargetTab(url, tabId) {
  const host = hostOf(url);
  if (tabId != null) {
    let t = null;
    try {
      t = await chrome.tabs.get(tabId);
    } catch {
      t = null;
    }
    if (!t) throw codedError("tab_closed", "вкладка " + tabId + " закрыта — открой страницу заново (browser_open) или возьми tabId из browser_tabs");
    // Жива и (хост совпал ИЛИ ещё грузится about:blank ИЛИ хост вообще не задан) → это наша вкладка.
    if (!host || hostOf(t.url || "") === host || !t.url || t.status !== "complete") return t;
  }
  if (host) {
    const tabs = await chrome.tabs.query({});
    const matches = tabs.filter((t) => hostOf(t.url || "") === host);
    if (!matches.length) return null;
    return matches.find((t) => t.active) || matches[0];
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return active || null;
}

/**
 * Дождаться, пока вкладка догрузится (для только что открытой browser_open — иначе скрипт бьёт в about:blank).
 * Честный исход (B-9): "complete" | "loading" (не дождались — вызывающий работает как есть, но говорит об этом) |
 * "gone" (вкладку закрыли). Раньше по таймауту возвращалось true — «готово», когда страница ещё грузилась.
 */
export async function waitForTabReady(tabId, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let t;
    try {
      t = await chrome.tabs.get(tabId);
    } catch {
      return "gone";
    }
    if (t && t.status === "complete") return "complete";
    await sleep(150);
  }
  return "loading";
}

/** Целевая вкладка, дождавшись загрузки: {tab, loading}. Нет вкладки → noTabError; закрыли, пока ждали, → tab_closed. */
export async function readyTargetTab(url, tabId) {
  const tab = await findTargetTab(url, tabId);
  if (!tab || tab.id == null) throw noTabError(url);
  if (tab.status === "complete") return { tab, loading: false };
  const st = await waitForTabReady(tab.id);
  if (st === "gone") throw codedError("tab_closed", "вкладка закрылась, пока грузилась");
  return { tab, loading: st !== "complete" };
}

/** Дождаться полной загрузки вкладки. */
export function waitTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (tab && tab.status === "complete") return resolve();
        if (Date.now() - t0 > timeoutMs) return resolve(); // не виснем — отдаём что есть
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

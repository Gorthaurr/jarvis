/**
 * Поиск/ожидание ЦЕЛЕВОЙ вкладки (SW-уровень) — вынесено из god-file background.js (§ревью split).
 * НЕ page-инжекторы (исполняются в service worker, не в странице) → дробятся свободно. Требует право tabs.
 */
import { hostOf, sleep } from "./utils.js";

/**
 * Найти ЦЕЛЕВУЮ вкладку. Приоритет — tabId из browser_open (точное попадание + лечит гонку
 * about:blank: свежая вкладка ещё без url, по хосту не находится, по id — сразу). Иначе по ХОСТУ
 * (среди совпадений — активная, иначе первая). Хост задан, но вкладки НЕТ → null (НЕ бьём в чужую
 * активную — это и был баг: play/read уходили в Telegram). Ни tabId, ни хоста → активная в окне.
 */
export async function findTargetTab(url, tabId) {
  const host = hostOf(url);
  if (tabId != null) {
    try {
      const t = await chrome.tabs.get(tabId);
      // Жива и (хост совпал ИЛИ ещё грузится about:blank ИЛИ хост вообще не задан) → это наша вкладка.
      if (t && (!host || hostOf(t.url || "") === host || !t.url || t.status !== "complete")) return t;
    } catch {
      /* вкладка закрыта — падаем на поиск по хосту */
    }
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

/** Дождаться, пока вкладка догрузится (для только что открытой browser_open — иначе скрипт бьёт в about:blank). */
export async function waitForTabReady(tabId, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let t;
    try {
      t = await chrome.tabs.get(tabId);
    } catch {
      return false; // вкладка исчезла
    }
    if (t && t.status === "complete") return true;
    await sleep(150);
  }
  return true; // не дождались — пробуем как есть
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

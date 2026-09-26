/**
 * browser_open: открыть URL в Chrome владельца, не плодя дубли и НЕ трогая его вкладки (B-15). Переиспользуем вкладку
 * только когда это безопасно:
 *  • уже открыт ТОТ ЖЕ адрес (хост + путь + query; #якорь не считается) → фокус;
 *  • просили голый хост («youtube.com»), а вкладка этого сайта есть → фокус без перехода (анти-дубль, ничего не теряем);
 *  • есть пустая вкладка (новая вкладка / about:blank) → открываем в ней;
 *  • иначе — НОВАЯ вкладка. Раньше вкладку того же хоста уводили на другой адрес — терялся несохранённый ввод владельца.
 * browser_open = «открой/покажи» → окно Chrome выводим на передний план. Требует право tabs.
 */
import { hostOf, urlPathQuery } from "./utils.js";

const BLANK = /^(about:blank|chrome:\/\/newtab\/?|chrome:\/\/new-tab-page\/?|edge:\/\/newtab\/?)$/i;

/** Окно Chrome — на передний план (Джарвис сам показывает результат, владелец не фокусит руками). */
export async function raiseWindow(windowId) {
  if (windowId == null) return;
  try {
    await chrome.windows.update(windowId, { focused: true, drawAttention: true });
  } catch {
    /* окно закрыто/недоступно — не критично */
  }
}

export async function openOrFocus(url) {
  if (!url) throw new Error("нужен url");
  const host = hostOf(url);
  const want = urlPathQuery(url);
  const tabs = await chrome.tabs.query({});
  const sameSite = host ? tabs.filter((t) => t.id != null && hostOf(t.url || "") === host) : [];
  const exact = sameSite.find((t) => urlPathQuery(t.url || "") === want) || (want === "/" ? sameSite[0] : undefined);
  if (exact) {
    await chrome.tabs.update(exact.id, { active: true });
    await raiseWindow(exact.windowId);
    return { focused: true, tabId: exact.id, url: exact.url || url };
  }
  const blank = tabs.find((t) => t.id != null && BLANK.test(String(t.url || t.pendingUrl || "")));
  if (blank) {
    await chrome.tabs.update(blank.id, { active: true, url });
    await raiseWindow(blank.windowId);
    return { navigated: true, reused: "blank", tabId: blank.id, url };
  }
  const tab = await chrome.tabs.create({ url, active: true });
  await raiseWindow(tab.windowId);
  return { created: true, tabId: tab.id, url };
}

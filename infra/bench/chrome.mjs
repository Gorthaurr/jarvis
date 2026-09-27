// Стенд: настоящий Chromium на Xvfb с распакованным расширением и фикстурами на НАСТОЯЩИХ именах хостов
// (--host-resolver-rules → 127.0.0.1, самоподписанный серт → --ignore-certificate-errors). CDP — только HTTP-эндпоинты
// (/json/*): список вкладок, закрыть, открыть, есть ли service worker расширения.
import { DISPLAY, PORTS, SCREEN, hosts } from "./config.mjs";

export function chromeArgs(p) {
  const map = Object.keys(hosts()).map((h) => `MAP ${h} 127.0.0.1`);
  // Всё прочее — NOTFOUND: стенд не ходит в интернет (и не утечёт на настоящие сайты под этими именами).
  const rules = [...map, "MAP * ~NOTFOUND", "EXCLUDE 127.0.0.1", "EXCLUDE localhost"].join(", ");
  return [
    "--no-sandbox",
    `--user-data-dir=${p.profile}`,
    `--load-extension=${p.ext}`,
    `--disable-extensions-except=${p.ext}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    `--host-resolver-rules=${rules}`,
    "--ignore-certificate-errors",
    "--no-proxy-server",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${PORTS.cdp}`,
    "--window-position=0,0",
    `--window-size=${SCREEN.w},${SCREEN.h}`,
    "--start-maximized",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--password-store=basic",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--lang=ru-RU",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ];
}

export function chromeEnv(base) {
  return { ...base, DISPLAY, LANGUAGE: "ru_RU" };
}

const CDP = `http://127.0.0.1:${PORTS.cdp}`;

async function cdpFetch(path, method = "GET") {
  const r = await fetch(`${CDP}${path}`, { method, signal: AbortSignal.timeout(5_000) });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export const cdp = {
  version: () => cdpFetch("/json/version"),
  list: () => cdpFetch("/json/list"),
  pages: async () => (await cdpFetch("/json/list")).filter((t) => t.type === "page"),
  close: (id) => cdpFetch(`/json/close/${id}`),
  newTab: (url) => cdpFetch(`/json/new?${encodeURIComponent(url)}`, "PUT"),
  activate: (id) => cdpFetch(`/json/activate/${id}`),
  /** Жив ли service worker расширения (MV3 засыпает; spawn по alarm/коннекту). */
  swAlive: async (extId) => (await cdpFetch("/json/list")).some((t) => t.type === "service_worker" && String(t.url).startsWith(`chrome-extension://${extId}/`)),
};

/** Оставить одну вкладку about:blank (сброс между сценариями). */
export async function resetTabs() {
  const pages = await cdp.pages();
  const blank = await cdp.newTab("about:blank");
  for (const t of pages) if (t.id !== blank.id) await cdp.close(t.id).catch(() => {});
  await cdp.activate(blank.id).catch(() => {});
  return blank.id;
}

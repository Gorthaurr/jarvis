import type { DesktopCore } from "./core.js";
export const NEWTAB = "chrome://newtab/";

/** Нормализация введённого в адресную строку: схема есть — как есть; похоже на хост — https; иначе поиск. */
export function normalizeAddress(raw: string): string {
  const t = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(t) || /^(about|chrome):/iu.test(t)) return t;
  if (!/\s/u.test(t) && (/\./u.test(t) || /^localhost(:\d+)?(\/|$)/iu.test(t))) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

/** Страница из seed.web: заголовок из <title>, текст без разметки. Нет в seed — оффлайн-страница с хостом в заголовке. */
export function loadPage(core: DesktopCore, url: string): { title: string; text: string; loaded: boolean } {
  if (url === NEWTAB || url === "about:blank") return { title: "Новая вкладка", text: "", loaded: true };
  const keys = [url, url.endsWith("/") ? url.slice(0, -1) : `${url}/`];
  const html = keys.map((k) => core.web.get(k)).find((v) => v !== undefined);
  if (html === undefined) {
    const host = url.replace(/^[a-z]+:\/\//iu, "").replace(/^www\./iu, "").split(/[/?#]/u)[0] ?? url;
    return { title: host, text: "Не удаётся получить доступ к сайту", loaded: false };
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]?.trim();
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/giu, " ").replace(/<[^>]+>/gu, " ").replace(/[ \t]+/gu, " ").replace(/\s*\n\s*/gu, "\n").trim();
  return { title: title || url, text, loaded: true };
}

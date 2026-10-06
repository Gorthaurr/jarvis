import { isPrivateHost } from "@jarvis/shared";
import type { DesktopCore } from "./core.js";
import { type DomNode, find, innerText, looksLikeHtml, parseHtml } from "./service-dom.js";
import type { Page } from "./service-page.js";
import { str } from "./service-state.js";
export interface Cookie {
  name: string;
  domain: string;
}
export interface Browser {
  page?: Page;
  title: string;
  cookies: Cookie[];
}

export const NO_NET = () => ({}); // DI интерфейсов: суд по имени, не по сетевым адресам хоста лаборатории
const LOGIN_PAGE = `<html><head><title>Вход</title></head><body><h1>Войдите в аккаунт</h1><form action="/login" method="post"><input name="login" placeholder="Логин"><input type="password" name="password" placeholder="Пароль"><button type="submit">Войти</button></form></body></html>`;

/** Ключ сравнения адресов: без схемы, фрагмента и хвостового слэша, хост в нижнем регистре. */
export function urlKey(u: string): string {
  try {
    const x = new URL(/^[a-z][a-z0-9+.-]*:/iu.test(u) ? u : `https://${u}`);
    return `${x.host}${x.pathname.replace(/\/+$/u, "")}${x.search}`.toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

/** Как safeBrowserUrl клиента: только http(s), не «-»-аргумент, не внутренняя сеть. Текст отказа или null. */
export function urlDenial(url: string): string | null {
  const u = str(url).trim();
  if (u.startsWith("-")) return "небезопасный URL: аргумент, начинающийся с «-», может быть воспринят как флаг браузера";
  const scheme = (/^([a-z][a-z0-9+.-]*):/iu.exec(u)?.[1] ?? "https").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return `небезопасная схема «${scheme}:» — открываю только http(s)`;
  if (isPrivateHost(u, NO_NET)) return "внутренний адрес (локальная сеть/loopback/метаданные) — в браузере Джарвиса не открываю";
  return null;
}

export function hasCookie(b: Browser, host: string, name: string): boolean {
  return b.cookies.some((c) => c.name === name && (host === c.domain.replace(/^\./u, "") || host.endsWith(`.${c.domain.replace(/^\./u, "")}`)));
}

/** Загрузить страницу из seed.web. */
export function loadPage(core: DesktopCore, b: Browser, url: string): { page: Page } | { missing: string } {
  const want = urlKey(url);
  const hit = [...core.web.entries()].find(([k]) => urlKey(k) === want);
  if (!hit) return { missing: `нет сети в лаборатории: страницы «${url}» нет в seed.web` };
  let root: DomNode = looksLikeHtml(hit[1]) ? parseHtml(hit[1]) : parseHtml(`<html><body><pre>${hit[1].replace(/&/gu, "&amp;").replace(/</gu, "&lt;")}</pre></body></html>`);
  let shown = url;
  const need = find(root, (n) => n.tag === "meta" && n.attrs.name === "lab-requires-cookie")?.attrs.content;
  if (need && !hasCookie(b, new URL(/^https?:/iu.test(url) ? url : `https://${url}`).hostname, need)) {
    root = parseHtml(LOGIN_PAGE); // стена входа: куки нет — настоящая страница недоступна
    shown = new URL("/login", /^https?:/iu.test(url) ? url : `https://${url}`).href;
  }
  return { page: { url: shown, root, scrollY: 0 } };
}

export function readPage(p: Page, title: string): Record<string, unknown> {
  const main = find(p.root, (n) => n.tag === "main" || n.tag === "article" || n.attrs.role === "main") ?? find(p.root, (n) => n.tag === "body") ?? p.root;
  const text = innerText(main).slice(0, 9000);
  const loginWall = !!find(p.root, (n) => n.tag === "input" && (n.attrs.type ?? "").toLowerCase() === "password") || /(?:passport\.|\/login|\/signin|\/sign-in|\/auth(?:\b|orize))/iu.test(p.url) || (text.length < 600 && /(?:войд(?:и|ите)|войти|войдите в аккаунт|вход в|sign\s?in|log\s?in|авториз)/iu.test(text));
  return { title, url: p.url, text, loginWall };
}

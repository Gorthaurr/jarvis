/**
 * jbrowser.* FakeDesktop — невидимый браузер Джарвиса ОФФЛАЙН: страницы берутся из `core.web` (seed.web), сети нет.
 * Правила клиента сохранены: только http(s), внутренние адреса (SSRF, B-14) — отказ, без Chrome в installedApps браузера
 * нет. Страница `<meta name="lab-requires-cookie" content="sid">` без такой куки показывает стену входа — так проверяется
 * перенос логинов (import_cookies). login только «открывает окно входа» (вводит владелец, §0) и НЕ логинит. Значения кук
 * хранятся только в памяти прогона и не попадают в журнал эффектов.
 */
import type { ActionCommand } from "@jarvis/protocol";
import { isPrivateHost } from "@jarvis/shared";
import type { DesktopCore, KindHandlers } from "./core.js";
import { type DomNode, find, innerText, looksLikeHtml, parseHtml, titleOf } from "./service-dom.js";
import { type ActEnv, type Page, PageFail, actOnPage, inspectPage } from "./service-jbrowser-act.js";
import { pathDenial, runState, str, vpath } from "./service-state.js";

interface Cookie {
  name: string;
  domain: string;
}
interface Browser {
  page?: Page;
  title: string;
  cookies: Cookie[];
}

const NO_NET = () => ({}); // DI интерфейсов: суд по имени, не по сетевым адресам хоста лаборатории
const LOGIN_PAGE = `<html><head><title>Вход</title></head><body><h1>Войдите в аккаунт</h1><form action="/login" method="post"><input name="login" placeholder="Логин"><input type="password" name="password" placeholder="Пароль"><button type="submit">Войти</button></form></body></html>`;

/** Ключ сравнения адресов: без схемы, фрагмента и хвостового слэша, хост в нижнем регистре. */
function urlKey(u: string): string {
  try {
    const x = new URL(/^[a-z][a-z0-9+.-]*:/iu.test(u) ? u : `https://${u}`);
    return `${x.host}${x.pathname.replace(/\/+$/u, "")}${x.search}`.toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

export function jbrowserHandlers(core: DesktopCore): KindHandlers {
  const st = (): Browser => runState<Browser>(core, "jbrowser", () => ({ title: "", cookies: [] }));
  const runtime = (m: { commandId: string }, msg: string) => core.fail(m.commandId, "runtime", msg);

  /** Как safeBrowserUrl клиента: только http(s), не «-»-аргумент, не внутренняя сеть. Текст отказа или null. */
  function urlDenial(url: string): string | null {
    const u = str(url).trim();
    if (u.startsWith("-")) return "небезопасный URL: аргумент, начинающийся с «-», может быть воспринят как флаг браузера";
    const scheme = (/^([a-z][a-z0-9+.-]*):/iu.exec(u)?.[1] ?? "https").toLowerCase();
    if (scheme !== "http" && scheme !== "https") return `небезопасная схема «${scheme}:» — открываю только http(s)`;
    if (isPrivateHost(u, NO_NET)) return "внутренний адрес (локальная сеть/loopback/метаданные) — в браузере Джарвиса не открываю";
    return null;
  }

  function hasCookie(b: Browser, host: string, name: string): boolean {
    return b.cookies.some((c) => c.name === name && (host === c.domain.replace(/^\./u, "") || host.endsWith(`.${c.domain.replace(/^\./u, "")}`)));
  }

  /** Загрузить страницу из seed.web. */
  function load(b: Browser, url: string): { page: Page } | { missing: string } {
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

  function navigate(b: Browser, url: string): { page: Page } | { blocked: string } | { missing: string } {
    const d = urlDenial(url);
    if (d) return { blocked: d };
    const r = load(b, url);
    if ("page" in r) {
      b.page = r.page;
      b.title = titleOf(r.page.root);
      core.effect("jbrowser.navigate", { url: r.page.url });
    }
    return r;
  }

  /** ensureBrowser клиента: без Chrome браузера нет. */
  const noChrome = (): string | null => (core.installedApps.has("chrome") ? null : "Chrome не найден — браузер Джарвиса недоступен");

  function readPage(p: Page, title: string): Record<string, unknown> {
    const main = find(p.root, (n) => n.tag === "main" || n.tag === "article" || n.attrs.role === "main") ?? find(p.root, (n) => n.tag === "body") ?? p.root;
    const text = innerText(main).slice(0, 9000);
    const loginWall = !!find(p.root, (n) => n.tag === "input" && (n.attrs.type ?? "").toLowerCase() === "password") || /(?:passport\.|\/login|\/signin|\/sign-in|\/auth(?:\b|orize))/iu.test(p.url) || (text.length < 600 && /(?:войд(?:и|ите)|войти|войдите в аккаунт|вход в|sign\s?in|log\s?in|авториз)/iu.test(text));
    return { title, url: p.url, text, loginWall };
  }

  const opened = (): Page | string => st().page ?? "браузер Джарвиса: страница не открыта — сначала jbrowser.open";

  return {
    "jbrowser.open": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "jbrowser.open" }>;
      const b = st();
      const bad = noChrome() ?? urlDenial(c.url);
      if (bad) return runtime(meta, bad);
      const r = navigate(b, c.url);
      if ("missing" in r) return core.fail(meta.commandId, "not_found", r.missing);
      if ("blocked" in r) return runtime(meta, r.blocked);
      core.effect("jbrowser.open", { url: c.url });
      return core.ok(meta.commandId, readPage(r.page, b.title));
    },

    "jbrowser.read": (_cmd, meta) => {
      const bad = noChrome();
      if (bad) return runtime(meta, bad);
      const p = opened();
      return typeof p === "string" ? runtime(meta, p) : core.ok(meta.commandId, readPage(p, st().title));
    },

    "jbrowser.inspect": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "jbrowser.inspect" }>;
      const bad = noChrome();
      if (bad) return runtime(meta, bad);
      const p = opened();
      return typeof p === "string" ? runtime(meta, p) : core.ok(meta.commandId, inspectPage(p, st().title, c.query ?? "", c.cap ?? 60));
    },

    "jbrowser.act": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "jbrowser.act" }>;
      const bad = noChrome();
      if (bad) return runtime(meta, bad);
      const p = opened();
      if (typeof p === "string") return runtime(meta, p);
      const b = st();
      const env: ActEnv = {
        nav: (u) => navigate(b, u),
        log: (kind, detail) => core.effect(kind, detail),
        file: (path) => {
          const abs = vpath(core, path);
          const denied = pathDenial(abs, false);
          const bytes = core.fs.files.get(abs);
          return denied ?? (bytes ? { abs, size: bytes.length } : `upload: файла «${abs}» нет или это не файл`);
        },
      };
      try {
        return core.ok(meta.commandId, actOnPage(p, env, c.intent, c.params ?? {}));
      } catch (e) {
        if (!(e instanceof PageFail)) throw e;
        return { ...core.fail(meta.commandId, e.code, `web_act ${c.intent}: ${e.message}`.slice(0, 400), e.data), ...(e.injected ? { stepActionInjected: true } : {}) };
      }
    },

    "jbrowser.login": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "jbrowser.login" }>;
      const bad = noChrome() ?? urlDenial(c.url);
      if (bad) return runtime(meta, bad);
      core.effect("jbrowser.login_window", { url: c.url }); // окно входа открыто; вводит владелец — лаборатория логин НЕ выполняет (§0)
      return core.ok(meta.commandId, { opened: c.url });
    },

    "jbrowser.import_cookies": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "jbrowser.import_cookies" }>;
      const bad = noChrome();
      if (bad) return runtime(meta, bad);
      if (!Array.isArray(c.cookies)) return runtime(meta, "import_cookies: cookies должен быть массивом");
      const b = st();
      let set = 0;
      for (const k of c.cookies) {
        if (!k?.name || !k?.domain) continue;
        b.cookies.push({ name: str(k.name), domain: str(k.domain) });
        set += 1;
      }
      core.effect("jbrowser.import_cookies", { set, total: c.cookies.length, domains: [...new Set(c.cookies.map((k) => str(k?.domain)).filter(Boolean))] });
      return core.ok(meta.commandId, { set, total: c.cookies.length });
    },
  };
}

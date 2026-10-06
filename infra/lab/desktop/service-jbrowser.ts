import { type Browser, loadPage, readPage, urlDenial } from "./service-jbrowser-pages.js";
/**
 * jbrowser.* FakeDesktop — невидимый браузер Джарвиса ОФФЛАЙН: страницы берутся из `core.web` (seed.web), сети нет.
 * Правила клиента сохранены: только http(s), внутренние адреса (SSRF, B-14) — отказ, без Chrome в installedApps браузера
 * нет. Страница `<meta name="lab-requires-cookie" content="sid">` без такой куки показывает стену входа — так проверяется
 * перенос логинов (import_cookies). login только «открывает окно входа» (вводит владелец, §0) и НЕ логинит. Значения кук
 * хранятся только в памяти прогона и не попадают в журнал эффектов.
 */
import type { ActionCommand } from "@jarvis/protocol";
import type { DesktopCore, KindHandlers } from "./core.js";
import { titleOf } from "./service-dom.js";
import { type ActEnv, type Page, PageFail, actOnPage, inspectPage } from "./service-jbrowser-act.js";
import { pathDenial, runState, str, vpath } from "./service-state.js";

export function jbrowserHandlers(core: DesktopCore): KindHandlers {
  const st = (): Browser => runState<Browser>(core, "jbrowser", () => ({ title: "", cookies: [] }));
  const runtime = (m: { commandId: string }, msg: string) => core.fail(m.commandId, "runtime", msg);

  function navigate(b: Browser, url: string): { page: Page } | { blocked: string } | { missing: string } {
    const d = urlDenial(url);
    if (d) return { blocked: d };
    const r = loadPage(core, b, url);
    if ("page" in r) {
      b.page = r.page;
      b.title = titleOf(r.page.root);
      core.effect("jbrowser.navigate", { url: r.page.url });
    }
    return r;
  }

  /** ensureBrowser клиента: без Chrome браузера нет. */
  const noChrome = (): string | null => (core.installedApps.has("chrome") ? null : "Chrome не найден — браузер Джарвиса недоступен");

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

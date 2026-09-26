// Стенд для page-функций расширения (26.09): НАСТОЯЩИЙ Chromium (headless, отдельный временный профиль — Chrome
// владельца не трогаем), НАСТОЯЩИЕ функции из background.js (те же, что chrome.scripting сериализует в страницу).
// jsdom/моки тут бесполезны: дефект H19 (синтетический Enter вместо клика) виден только на реальной семантике
// активации элементов браузером.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));

export function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  return cands.find((p) => p && existsSync(p)) ?? null;
}

/**
 * Исходники page-функций из background.js. Скрипт исполняется в vm с заглушкой `chrome`: объявления функций
 * всплывают ДО исполнения верхнего кода, так что toString() отдаёт ровно то, что уходит в страницу.
 */
export function pageFunctionSources(names) {
  const src = readFileSync(join(here, "..", "background.js"), "utf8").replace(/^import .*$/gmu, "");
  const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  // Таймеры — заглушки: верхний код SW (реконнект, keep-alive) иначе завёл бы НАСТОЯЩИЕ таймеры и держал node --test.
  const noop = () => 0;
  const sandbox = { chrome: stub, console, setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop, URL };
  vm.createContext(sandbox);
  try {
    vm.runInContext(src, sandbox, { filename: "background.js" });
  } catch {
    /* верхний код может упасть на заглушках — объявления функций к этому моменту уже есть */
  }
  const out = {};
  for (const n of names) {
    if (typeof sandbox[n] !== "function") throw new Error(`page-функция ${n} не найдена в background.js`);
    out[n] = sandbox[n].toString();
  }
  return out;
}

/**
 * НАСТОЯЩИЕ модули SW (modules/*.js) одним скриптом для vm: импорты вырезаны, экспорт → глобальные var/function —
 * их видит background.js, а overrides теста перекрывают (var и function — свойства глобального объекта).
 */
function moduleSources() {
  const dir = join(here, "..", "modules");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) =>
      readFileSync(join(dir, f), "utf8")
        .replace(/^import .*$/gmu, "")
        .replace(/^export (async function|function|class) /gmu, "$1 ")
        .replace(/^export (const|let) /gmu, "var "),
    )
    .join("\n");
}

/**
 * Service worker расширения в vm — для юнитов SW-уровня (tabAct: какой page-функцией и с какими аргументами он зовёт
 * страницу). Функции modules/* — НАСТОЯЩИЕ (см. moduleSources); `chrome.tabs`/`scripting`/`windows`/`runtime` и
 * любые глобалы подменяются overrides (они побеждают модули); остальное chrome — глухая заглушка, таймеры и сокет —
 * пустышки (верхний код SW не должен жить дальше теста). Настоящие таймеры — передать setTimeout в overrides.
 */
export function loadServiceWorker(overrides = {}) {
  const src = moduleSources() + "\n" + readFileSync(join(here, "..", "background.js"), "utf8").replace(/^import .*$/gmu, "");
  const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  const { tabs, scripting, windows, runtime, ...globals } = overrides;
  const own = { tabs, scripting, windows, runtime };
  const chrome = new Proxy(stub, { get: (_t, k) => own[k] || stub });
  const noop = () => 0;
  class FakeSocket { constructor() {} send() {} close() {} }
  const sandbox = { chrome, console, setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop, URL, WebSocket: FakeSocket, ...globals };
  vm.createContext(sandbox);
  try {
    vm.runInContext(src, sandbox, { filename: "background.js" });
  } catch {
    /* хвост верхнего кода на заглушках — функции и константы к этому моменту уже есть */
  }
  Object.assign(sandbox, globals); // объявления модулей перезаписали одноимённые overrides — возвращаем подмены теста
  return sandbox;
}

/**
 * SW в vm поверх НАСТОЯЩЕЙ страницы: chrome.scripting.executeScript исполняет page-функцию в headless Chrome
 * (world:"MAIN" — в мире страницы, иначе — в изолированном мире, как у расширения), вкладка №1 = эта страница,
 * goBack/goForward — история этой страницы. Проверяет связку «маршрут SW → page-функция» целиком, без моков DOM.
 */
export function swOnPage(page, extra = {}) {
  const calls = [];
  const live = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const [url, title, ready] = await page.eval("[location.href, document.title, document.readyState]");
        return { id: 1, windowId: 1, active: true, status: ready === "complete" ? "complete" : "loading", url, title };
      } catch {
        await new Promise((r) => setTimeout(r, 50)); // документ сменяется — ждём новый контекст
      }
    }
    throw new Error("страница не отвечает");
  };
  const history = (dir) => async (id) => {
    if (id !== 1) throw new Error("No tab with id: " + id);
    const can = await page.eval(`navigation.${dir === "back" ? "canGoBack" : "canGoForward"}`);
    if (!can) throw new Error(`Cannot find a ${dir === "back" ? "previous" : "next"} page in history.`);
    await page.eval(`history.${dir}()`);
  };
  const { tabs, ...globals } = extra;
  const env = loadServiceWorker({
    tabs: {
      get: async (id) => { if (id !== 1) throw new Error("No tab with id: " + id); return live(); },
      query: async () => [await live()],
      goBack: history("back"),
      goForward: history("forward"),
      ...tabs,
    },
    scripting: {
      executeScript: async (inj) => {
        calls.push(inj);
        const src = inj.func.toString();
        const result = inj.world === "MAIN" ? await page.call(src, ...(inj.args || [])) : await page.callIsolated(src, ...(inj.args || []));
        return [{ frameId: 0, result }];
      },
    },
    setTimeout,
    clearTimeout,
    ...globals,
  });
  return { env, calls };
}

export const fixtureUrl = (name) => pathToFileURL(join(here, "fixtures", name)).href;

/**
 * НАСТОЯЩИЙ регэксп гарда, который сервер шлёт странице на учебной/неизвестной вкладке (pageGuardFor): исходники
 * литералов из commit-risk.ts и commit-lms.ts. Самодельный «отправ|submit» не ловил склейку подписи и якоря (ревью 26.09).
 */
export function serverGuardSource() {
  const lit = (file, name) => {
    const src = readFileSync(join(here, "..", "..", "..", file), "utf8");
    const m = new RegExp(`${name}\\s*=\\s*\\/(.+)\\/iu;`, "u").exec(src);
    if (!m) throw new Error(`не нашёл ${name} в ${file}`);
    return m[1];
  };
  return `${lit("packages/shared/src/commit-risk.ts", "COMMIT_WORDS_RE")}|${lit("apps/server/src/brain/tools/commit-lms.ts", "LMS_COMMIT_RE")}`;
}

/**
 * Headless Chrome + одна вкладка. Возвращает { open(url), call(fnSrc, ...args) — в мире страницы (как world:"MAIN"),
 * callIsolated(fnSrc, ...args) — в изолированном мире (как executeScript расширения по умолчанию; реестр ref живёт
 * там, пока жив документ), eval(expr), close() }. Сеть наружу закрыта (host-resolver): стенд герметичен.
 */
export async function launchPage() {
  const chrome = findChrome();
  if (!chrome) return null;
  const profile = mkdtempSync(join(tmpdir(), "jarvis-ext-test-"));
  const hermetic = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1";
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files", hermetic, `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore", windowsHide: true });
  proc.unref(); // иначе дерево Chrome держит цикл событий и node --test не завершается
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const port = readFileSync(portFile, "utf8").split(/\r?\n/u)[0];
  let targets = [];
  for (let i = 0; i < 50; i++) {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json().catch(() => []);
    if (targets.some((t) => t.type === "page")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression, contextId) => {
    const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
    if (m.error) throw new Error(m.error.message);
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text);
    return m.result?.result?.value;
  };
  // Фоновая вкладка без фокуса не даёт execCommand/requestSubmit вести себя как у живой вкладки — эмулируем фокус.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // Изолированный мир — один на документ (как у расширения): реестр ref переживает вызовы, умирает с навигацией.
  let iso = null;
  const isolated = async () => {
    // Жив ли мир (смена документа его уничтожает; смена #hash — нет, как у расширения).
    if (iso && (await evaluate("1", iso.ctx).then(() => true, () => false))) return iso.ctx;
    const tree = await send("Page.getFrameTree");
    const r = await send("Page.createIsolatedWorld", { frameId: tree.result.frameTree.frame.id, worldName: "jarvis-ext-test" });
    iso = { ctx: r.result.executionContextId };
    return iso.ctx;
  };
  const args = (a) => `(...${JSON.stringify(a)})`;
  return {
    async open(url) {
      iso = null;
      await send("Page.enable");
      await send("Page.navigate", { url });
      for (let i = 0; i < 100; i++) {
        if ((await evaluate("document.readyState").catch(() => "")) === "complete") return;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    call: (fnSrc, ...a) => evaluate(`(${fnSrc})${args(a)}`),
    callIsolated: async (fnSrc, ...a) => evaluate(`(${fnSrc})${args(a)}`, await isolated()),
    eval: evaluate,
    async close() {
      ws.onmessage = null;
      try { ws.close(); } catch { /* ignore */ }
      // На Windows kill() гасит только главный процесс — дочерние (renderer/gpu) живут дальше: гасим всё дерево.
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
      else proc.kill();
      await new Promise((r) => setTimeout(r, 500));
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* профиль мог быть ещё занят */ }
    },
  };
}

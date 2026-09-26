// Стенд для page-функций расширения (26.09): НАСТОЯЩИЙ Chromium (headless, отдельный временный профиль — Chrome
// владельца не трогаем), НАСТОЯЩИЕ функции из background.js (те же, что chrome.scripting сериализует в страницу).
// jsdom/моки тут бесполезны: дефект H19 (синтетический Enter вместо клика) виден только на реальной семантике
// активации элементов браузером.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** Headless Chrome + одна вкладка. Возвращает { open(url), call(fnSrc, ...args), eval(expr), close() }. */
export async function launchPage() {
  const chrome = findChrome();
  if (!chrome) return null;
  const profile = mkdtempSync(join(tmpdir(), "jarvis-ext-test-"));
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore", windowsHide: true });
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
  const evaluate = async (expression) => {
    const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text);
    return m.result?.result?.value;
  };
  return {
    async open(url) {
      await send("Page.enable");
      await send("Page.navigate", { url });
      for (let i = 0; i < 100; i++) {
        if ((await evaluate("document.readyState").catch(() => "")) === "complete") return;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    call: (fnSrc, ...args) => evaluate(`(${fnSrc})(...${JSON.stringify(args)})`),
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

// Стенд НАСТОЯЩЕГО расширения (27.09): service worker в настоящем Chrome — настоящие chrome.scripting/chrome.tabs и
// back/forward-кэш. Стенд page-функций (cdp-harness: Runtime.evaluate) их не воспроизводит: там уход страницы рвёт
// CDP-вызов ошибкой, а у executeScript замороженный bfcache-документ молчит минутами (боевой Moodle «Вход» 27.09).
// Расширение — КОПИЯ во временном каталоге: WS_URL переписан на мёртвый порт (к боевому серверу на 8787 стенд не
// подключается никогда — не нашёл строку, значит не запускаю), ответ SW серверу replyFor(msg, handle) выставлен в
// globalThis для CDP. Загрузка — CDP Extensions.loadUnpacked через pipe: фирменный Chrome ≥137 игнорирует --load-extension.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "./cdp-harness.mjs";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROD_WS = 'const WS_URL = "ws://127.0.0.1:8787/ext";';

/** Бандл SW как в apps/client/scripts/build.mjs (esbuild, iife), но из копии background.js с тестовыми швами. */
async function buildCopy(out) {
  const src = readFileSync(join(extDir, "background.js"), "utf8");
  if (!src.includes(PROD_WS)) throw new Error("стенд: строка WS_URL в background.js не найдена — не рискую подключиться к боевому серверу");
  const contents = src.replace(PROD_WS, 'const WS_URL = "ws://127.0.0.1:9/ext";') + "\nglobalThis.__jarvisReply = (msg) => replyFor(msg, handle);\n";
  const esbuild = createRequire(join(extDir, "..", "client", "package.json"))("esbuild");
  mkdirSync(join(out, "dist"), { recursive: true });
  await esbuild.build({ stdin: { contents, resolveDir: extDir, sourcefile: "background.js" }, bundle: true, target: "es2022", format: "iife", platform: "browser", outfile: join(out, "dist", "background.js"), logLevel: "silent" });
  writeFileSync(join(out, "manifest.json"), readFileSync(join(extDir, "manifest.json")));
}

/** CDP поверх --remote-debugging-pipe: fd3 — в Chrome, fd4 — из Chrome, сообщения JSON с нулевым байтом в конце. */
function pipeCdp(proc) {
  const [, , , toChrome, fromChrome] = proc.stdio;
  const pending = new Map();
  let id = 0;
  let buf = "";
  fromChrome.on("data", (d) => {
    buf += d.toString("utf8");
    for (let i = buf.indexOf("\0"); i >= 0; i = buf.indexOf("\0")) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); toChrome.write(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"); });
  return { send, end: () => { try { toChrome.end(); fromChrome.destroy(); } catch { /* уже закрыт */ } } };
}

/**
 * Headless Chrome с расширением. null — нет Chrome или он не умеет Extensions.loadUnpacked (тест пропускается).
 * { reply(msg, capMs) → {reply, ms} — ответ SW серверу (как ушёл бы в /ext) или {timeout:true} по капу;
 *   sw(expr) — выражение в SW; openTab(url) → tabId (дождавшись загрузки); tab(id) → {url, status}; close() }.
 */
export async function launchExtension() {
  const chrome = findChrome();
  if (!chrome) return null;
  const dir = mkdtempSync(join(tmpdir(), "jarvis-ext-sw-"));
  await buildCopy(join(dir, "ext"));
  const hermetic = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1";
  const rootOnly = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  const args = [...rootOnly, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", hermetic, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${join(dir, "profile")}`, "about:blank"];
  const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
  const cdp = pipeCdp(proc);
  const close = async () => {
    cdp.end();
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    else proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* профиль ещё занят */ }
  };
  const loaded = await cdp.send("Extensions.loadUnpacked", { path: join(dir, "ext") });
  if (loaded.error) { await close(); return null; }
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    const t = await cdp.send("Target.getTargets");
    target = (t.result?.targetInfos ?? []).find((x) => x.type === "service_worker" && x.url.includes(loaded.result.id));
    if (!target) await new Promise((r) => setTimeout(r, 100));
  }
  if (!target) { await close(); throw new Error("стенд: service worker расширения не поднялся"); }
  const { result } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sw = async (expression) => {
    const m = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, result.sessionId);
    if (m.error) throw new Error(m.error.message);
    if (m.result.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text);
    return m.result.result.value;
  };
  // Цель SW появляется раньше, чем его скрипт исполнился (под нагрузкой параллельного набора — «chrome is not defined»).
  const ready = "typeof chrome === 'object' && Boolean(chrome.tabs) && typeof globalThis.__jarvisReply === 'function'";
  for (let i = 0; i < 200 && !(await sw(ready).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 50));
  const tab = (id) => sw(`chrome.tabs.get(${Number(id)}).then((t) => ({ url: t.url, status: t.status }))`);
  return {
    sw,
    tab,
    async openTab(url) {
      const id = await sw(`chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false }).then((t) => t.id)`);
      for (let i = 0; i < 100 && (await tab(id)).status !== "complete"; i++) await new Promise((r) => setTimeout(r, 50));
      return id;
    },
    async reply(msg, capMs) {
      const t0 = Date.now();
      const reply = await sw(`Promise.race([globalThis.__jarvisReply(${JSON.stringify(msg)}), new Promise((r) => setTimeout(() => r({ timeout: true }), ${Number(capMs)}))])`);
      return { reply, ms: Date.now() - t0 };
    },
    close,
  };
}

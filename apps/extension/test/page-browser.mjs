import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withBrowserFixture } from "./browser-fixture.mjs";

export async function launchBrowserPage(chrome) {
  if (!chrome) return null;
  return withBrowserFixture("jarvis-ext-test-", async (fixture) => {
    const profile = fixture.dir;
    const hermetic = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1";
    // Под root (Linux-облако) Chromium без --no-sandbox не стартует; у владельца (Windows) флаг не нужен.
    const rootOnly = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
    const proc = fixture.spawn(chrome, [...rootOnly, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files", hermetic, `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore", windowsHide: true });
    proc.unref(); // иначе дерево Chrome держит цикл событий и node --test не завершается
    // Под параллельной нагрузкой (node --test гоняет файлы одновременно, у каждого свой Chrome) файл порта появляется
    // пустым, а /json отвечает не сразу — ждём содержимое и цель-страницу, а не просто существование файла.
    const portFile = join(profile, "DevToolsActivePort");
    let port = "";
    for (let i = 0; i < 300 && !port; i++) {
      fixture.assertRunning();
      try { port = readFileSync(portFile, "utf8").split(/\r?\n/u)[0].trim(); } catch { /* ещё нет */ }
      if (!port) await new Promise((r) => setTimeout(r, 100));
    }
    if (!port) throw new Error("Chrome не открыл порт отладки за 30 с");
    let targets = [];
    for (let i = 0; i < 200; i++) {
      fixture.assertRunning();
      targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
      if (targets.some((t) => t.type === "page")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("у Chrome нет вкладки-страницы для стенда");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    fixture.onClose(() => { ws.onmessage = null; try { ws.close(); } catch { /* already closed */ } });
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
      /** Снимок вьюпорта PNG data:-URL (физические пиксели) — как chrome.tabs.captureVisibleTab. */
      screenshot: async () => "data:image/png;base64," + (await send("Page.captureScreenshot", { format: "png" })).result.data,
      /** Сырой CDP-вызов (эмуляция dpr и т.п.). */
      cdp: (method, params) => send(method, params),
      close: () => fixture.close(),
    };
  });
}

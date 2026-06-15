/**
 * DE-RISK / прототип: НЕВИДИМАЯ отправка в Telegram через выделенный Chrome + CDP.
 *
 * Связка: отдельный профиль (ASCII!) + occlusion-off флаги + окно за экраном (-3000) →
 * Chrome рендерит невидимо → драйвим webK по CDP. КЛЮЧЕВОЕ: текст в управляемый contenteditable
 * webK кладём НАТИВНЫМИ CDP-событиями (Input.insertText + Input.dispatchKeyEvent Enter) — DOM-хаки
 * (execCommand/textContent) НЕ кладут текст в модель webK → ложная «успешная» отправка.
 * Подтверждение отправки — по появлению ИСХОДЯЩЕГО пузыря с текстом, не по «поле очистилось».
 *
 *   node stealth-tg.mjs login                       — видимый вход (1 раз, нужен 2FA-пароль)
 *   node stealth-tg.mjs send "Избранное" "текст"    — невидимая отправка за экраном
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE = process.env.JARVIS_TG_PROFILE || "C:\\Users\\anton\\AppData\\Local\\JarvisTG\\tg-profile";
const STEALTH_FLAGS = [
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("нет свободного порта"))));
    });
  });
}

// ── helpers, ставятся в window.__tgh один раз (переиспользуются всеми фазами) ──
const HELPERS = `window.__tgh = (() => {
  const visible = (el) => {
    if (!el) return false;
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    const b = el.getBoundingClientRect();
    return b.width > 1 && b.height > 1;
  };
  const lc = (s) => String(s || "").toLowerCase();
  const q = (sels) => { for (const s of sels) { const el = document.querySelector(s); if (el && visible(el)) return el; } return null; };
  const findSearch = () => {
    const known = q(['.input-search input', 'input.input-search-input', '#column-left input.input-field-input', '.sidebar-header input']);
    if (known) return known;
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const byHint = inputs.find((el) => { const h = lc(el.placeholder) + " " + lc(el.getAttribute("aria-label")); return h.includes("search") || h.includes("поиск"); });
    if (byHint) return byHint;
    const left = document.querySelector('#column-left, .sidebar-left, [class*="left" i]') || document;
    return [...left.querySelectorAll('input[type="text"], input:not([type]), input.input-field-input')].find(visible) || null;
  };
  const findMsgInput = () => {
    const known = q(['.input-message-input[contenteditable="true"]', 'div.input-message-input']);
    if (known) return known;
    const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
    return eds.find((el) => { const h = lc(el.getAttribute("aria-label")) + " " + lc(el.dataset && el.dataset.placeholder) + " " + lc(el.className); return h.includes("message") || h.includes("сообщен") || h.includes("input-message"); }) || eds[eds.length - 1] || null;
  };
  const dumpDom = () => {
    const hasAuthClass = document.body ? document.body.classList.contains("has-auth-pages") : false;
    return {
      url: location.href, title: document.title,
      hasAuthClass, visibilityState: document.visibilityState,
      hasChatlist: Boolean(document.querySelector('.chatlist, ul.chatlist, #folders-container')),
      looksLoggedIn: !hasAuthClass,
      inputCount: document.querySelectorAll('input').length,
      ceCount: document.querySelectorAll('[contenteditable="true"]').length,
      bodyText: (document.body ? document.body.innerText || "" : "").replace(/\\s+/g, " ").trim().slice(0, 300),
    };
  };
  const setInput = (el, val) => {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  };
  const realClick = (el) => { for (const t of ["pointerdown","mousedown","pointerup","mouseup","click"]) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitForFn = async (fn, timeout) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const el = fn(); if (el) return el; await sleep(200); } return null; };
  return { visible, lc, q, findSearch, findMsgInput, dumpDom, setInput, realClick, sleep, waitForFn };
})();
true;`;

// Фаза 1: дойти до открытого чата с целью и сфокусировать поле сообщения. Вернуть rect поля.
function tgPrepare(to) {
  const H = window.__tgh;
  return (async () => {
    await H.sleep(300);
    let d = H.dumpDom();
    if (!d.looksLoggedIn && !d.hasChatlist) { await H.sleep(2500); d = H.dumpDom(); if (!d.looksLoggedIn) return { ok: false, step: "not-logged-in", dom: d }; }

    const wantSaved = /избранн|saved/i.test(to);
    if (wantSaved) {
      // «Избранное»/Saved Messages — открываем через меню (≡), БЕЗ поиска: поиск по слову
      // «Избранное» матчит ЧУЖИЕ КАНАЛЫ с этим словом → клик подписывает на них. Меню безопасно.
      const findMenuBtn = () => H.q(['.sidebar-tools-button', '.btn-menu-toggle.sidebar-tools-button', '.sidebar-header .btn-menu-toggle', 'button.btn-menu-toggle']);
      const mb = await H.waitForFn(findMenuBtn, 10000);
      if (!mb) return { ok: false, step: "menu-button", dom: H.dumpDom() };
      H.realClick(mb);
      await H.sleep(800);
      const findSaved = () => [...document.querySelectorAll('.btn-menu-item, [class*="menu-item" i]')].filter(H.visible).find((el) => {
        const t = H.lc(el.textContent); const ic = H.lc(el.innerHTML);
        return t.includes("saved") || t.includes("избранн") || ic.includes("savedmessages") || ic.includes("saved-messages") || ic.includes("saved_messages");
      });
      const sm = await H.waitForFn(findSaved, 6000);
      if (!sm) return { ok: false, step: "saved-menu-item", dom: H.dumpDom() };
      H.realClick(sm);
      await H.sleep(1800);
    } else {
      // Именованный контакт: поиск + СТРОГИЙ матч по названию (приоритет точному равенству),
      // только среди уже существующих диалогов/контактов (не вступаем в публичные каналы).
      const search = await H.waitForFn(H.findSearch, 15000);
      if (!search) return { ok: false, step: "search-input", dom: H.dumpDom() };
      H.realClick(search); search.focus(); H.setInput(search, to);
      await H.sleep(2200);
      const titleOf = (el) => H.lc((el.querySelector('.peer-title, .user-title, [class*="title" i]') || el).textContent).trim();
      const want = H.lc(to).trim();
      const items = () => [...document.querySelectorAll('a.chatlist-chat, li.chatlist-chat, .chatlist-chat, ul.chatlist > a, [class*="chatlist-chat" i]')].filter(H.visible);
      const findResult = () => items().find((el) => titleOf(el) === want) || null;
      const result = await H.waitForFn(findResult, 10000);
      if (!result) return { ok: false, step: "search-result", note: "нет ТОЧНОГО совпадения по имени — не шлём наугад", dom: H.dumpDom() };
      H.realClick(result);
      await H.sleep(2000);
    }
    const input = await H.waitForFn(H.findMsgInput, 15000);
    if (!input) return { ok: false, step: "message-input", dom: H.dumpDom() };
    input.focus();
    const b = input.getBoundingClientRect();
    return { ok: true, chatTitle: (document.querySelector('.chat-info .peer-title, .topbar .peer-title, .chat .user-title') || {}).textContent || "", rect: { x: b.x, y: b.y, w: b.width, h: b.height } };
  })();
}

// Фаза 2: что сейчас в поле сообщения (подтвердить, что текст реально лёг в модель webK).
function tgTyped() {
  const H = window.__tgh;
  const input = H.findMsgInput();
  return { found: Boolean(input), text: input ? (input.textContent || "").trim() : "" };
}

// Фаза 3: подтверждение отправки — появился ли ИСХОДЯЩИЙ пузырь с нашим текстом.
function tgVerify(text) {
  const H = window.__tgh;
  const want = String(text).trim();
  const outSel = '.bubble.is-out, .message.is-out, [class*="bubble" i][class*="is-out" i], .bubbles-group-out .bubble';
  const outgoing = [...document.querySelectorAll(outSel)];
  const delivered = outgoing.some((b) => (b.textContent || "").includes(want));
  const input = H.findMsgInput();
  return {
    delivered,
    outgoingCount: outgoing.length,
    lastOutgoing: outgoing.length ? (outgoing[outgoing.length - 1].textContent || "").trim().slice(0, 80) : "",
    inputCleared: input ? (input.textContent || "").trim().length === 0 : null,
  };
}

// ── persistent мини-CDP-клиент ──
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      const WS = globalThis.WebSocket;
      if (!WS) return rej(new Error("global WebSocket недоступен (Node 22+)"));
      this.ws = new WS(this.wsUrl);
      const t = setTimeout(() => rej(new Error("WS timeout")), 10000);
      this.ws.addEventListener("open", () => { clearTimeout(t); res(); });
      this.ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("WS error")); });
      this.ws.addEventListener("message", (ev) => this.onMsg(String(ev.data ?? "")));
    });
  }
  onMsg(d) { let m; try { m = JSON.parse(d); } catch { return; } if (typeof m.id !== "number") return; const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message || "cdp err")); else p.res(m.result); }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("timeout " + method)); } }, 30000);
    });
  }
  async evaluate(fnOrExpr, ...args) {
    const expr = typeof fnOrExpr === "function" ? `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})` : fnOrExpr;
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

async function discoverWs(port) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json`);
      if (resp.ok) { const ts = await resp.json(); const p = ts.find((t) => t.type === "page" && t.webSocketDebuggerUrl); if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl; }
    } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error("debug-порт не открылся за 15с");
    await sleep(250);
  }
}

async function main() {
  const mode = process.argv[2] || "send";
  if (mode === "login") {
    const args = [`--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--window-position=200,80", "--window-size=660,880", "https://web.telegram.org/k/"];
    const proc = spawn(CHROME, args, { detached: true, stdio: "ignore" });
    proc.unref();
    console.log(`[login] Открыл Telegram ВИДИМО (PID ${proc.pid}). Войди ПОЛНОСТЬЮ (номер→код→2FA-пароль), потом ЗАКРОЙ окно. Профиль: ${PROFILE}`);
    return;
  }
  const to = process.argv[3] || "Избранное";
  const text = process.argv[4] || "тест CDP " + Math.floor(Date.now() / 1000) % 100000;
  const port = await getFreePort();
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${PROFILE}`, "--remote-allow-origins=*",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    ...STEALTH_FLAGS, "--window-position=-3000,0", "--window-size=520,800", "https://web.telegram.org/k/"];
  console.log(`[send] off-screen Chrome port=${port}, to="${to}", text="${text}"`);
  const proc = spawn(CHROME, args, { stdio: "ignore", windowsHide: true });
  let cdp;
  try {
    const wsUrl = await discoverWs(port);
    cdp = new Cdp(wsUrl);
    await cdp.connect();
    await sleep(3500); // webK холодный старт
    await cdp.evaluate(HELPERS);
    const prep = await cdp.evaluate(tgPrepare, to);
    console.log("[prepare] " + JSON.stringify(prep));
    if (!prep.ok) { console.log("[send] ПРОВАЛ на " + prep.step); return; }
    // реальный фокус поля: CDP-клик по его центру
    if (prep.rect && prep.rect.w > 0) {
      const cx = prep.rect.x + prep.rect.w / 2, cy = prep.rect.y + prep.rect.h / 2;
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
      await sleep(200);
    }
    // НАТИВНЫЙ ввод текста (webK получит настоящий beforeinput/input → положит в модель)
    await cdp.send("Input.insertText", { text });
    await sleep(500);
    const typed = await cdp.evaluate(tgTyped);
    console.log("[typed] " + JSON.stringify(typed));
    // отправка: нативный Enter
    const enter = (type) => cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await enter("keyDown"); await enter("keyUp");
    await sleep(1300);
    const verify = await cdp.evaluate(tgVerify, text);
    console.log("[verify] " + JSON.stringify(verify));
    console.log(verify.delivered ? "[send] ✅ ДОСТАВЛЕНО (исходящий пузырь найден)" : "[send] ❌ НЕ доставлено (пузыря с текстом нет)");
  } catch (e) {
    console.log("[send] ОШИБКА: " + (e instanceof Error ? e.message : String(e)));
  } finally {
    try { cdp?.close(); } catch { /* */ }
    try { proc.kill(); } catch { /* */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

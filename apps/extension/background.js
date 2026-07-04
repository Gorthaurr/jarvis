/**
 * Jarvis Web Hands — service worker расширения.
 *
 * Связь с сервером Джарвиса по WS (ws://127.0.0.1:8787/ext). Сервер шлёт интенты
 * ({id, type, ...}); расширение исполняет их в ТВОЁМ Chrome на ТВОИХ логинах через
 * ФОНОВУЮ вкладку (active:false) и отвечает {id, ok, data|error}. Никаких новых входов,
 * никакого debug-порта, вкладка в фоне → почти невидимо.
 */

import { sleep, hostOf, urlPathQuery, noTabError } from "./modules/utils.js";
import { findTargetTab, waitForTabReady, waitTabComplete } from "./modules/tab-find.js";
import { cookiesExport } from "./modules/cookies.js";
import { startKeepAlive } from "./modules/keep-alive.js";

const WS_URL = "ws://127.0.0.1:8787/ext";
let ws = null;
let reconnectTimer = null;

function connect() {
  // Закрываем прежний сокет и снимаем таймер — иначе alarm-keepalive и scheduleReconnect
  // могут поднять ДВА параллельных WebSocket, старый повиснет (гонка переподключения).
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.onclose = null;
      ws.close();
    } catch {
      /* уже мёртв */
    }
    ws = null;
  }
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    console.log("[jarvis] подключился к серверу");
    send({ type: "hello", agent: "jarvis-web-hands", version: "0.1.0" });
  };
  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || !msg.id) return;
    try {
      const data = await handle(msg);
      send({ id: msg.id, ok: true, data });
    } catch (e) {
      send({ id: msg.id, ok: false, error: String((e && e.message) || e) });
    }
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

/** Роутинг интентов сервера. */
async function handle(msg) {
  switch (msg.type) {
    case "ping":
      return "pong";
    case "reload":
      // DEV: перечитать РАСПАКОВАННОЕ расширение с диска (подхватывает правки background.js
      // без ручного ↻ в chrome://extensions). Отвечаем СЕЙЧАС, reload — через микрозадержку,
      // иначе SW умрёт раньше, чем уйдёт ответ. После reload SW сам переподключится по WS.
      setTimeout(() => { try { chrome.runtime.reload(); } catch (e) { /* ignore */ } }, 150);
      return "reloading";
    case "telegram.send":
      return telegramSend(String(msg.to || ""), String(msg.text || ""), Array.isArray(msg.variants) ? msg.variants : []);
    case "telegram.diag":
      return telegramDiag(String(msg.query || ""));
    case "telegram.unread":
      return telegramUnread();
    case "telegram.send_voice":
      return telegramSendVoice(String(msg.to || ""), String(msg.audioB64 || ""));
    case "tab.openOrFocus":
      return openOrFocus(String(msg.url || ""));
    case "tab.list":
      return tabList();
    case "tab.close":
      return tabClose(msg.url ? String(msg.url) : "", msg.tabId);
    case "tab.read":
      return tabRead(msg.url ? String(msg.url) : "", msg.tabId);
    case "tab.inspect":
      return tabInspect(msg.url ? String(msg.url) : "", msg.query ? String(msg.query) : "", msg.cap, msg.tabId);
    case "tab.act":
      return tabAct(msg.url ? String(msg.url) : "", String(msg.intent || ""), msg.params || {}, msg.tabId);
    case "cookies.export":
      return cookiesExport(Array.isArray(msg.domains) ? msg.domains : null);
    default:
      throw new Error("неизвестный интент: " + msg.type);
  }
}

/** Прочитать ЦЕЛЕВУЮ (tabId из open / по хосту url) вкладку — в ТВОЕЙ залогиненной сессии. */
async function tabRead(url, tabId) {
  const tab = await findTargetTab(url, tabId);
  if (!tab || tab.id == null) throw noTabError(url);
  if (tab.status !== "complete") await waitForTabReady(tab.id);
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageInPage });
  return (res && res.result) || { title: tab.title || "", url: tab.url || "", text: "" };
}

/**
 * ГЛАЗА В DOM: снимок интерактивных элементов вкладки (кнопки/ссылки/инпуты) с УСТОЙЧИВЫМИ селекторами,
 * текстом, aria-label, ролью, состоянием. Чтобы модель САМА видела реальную страницу и прицельно
 * действовала browser_act{selector}, а не угадывала. Универсально (любой сайт), без хардкода под сервис.
 */
async function tabInspect(url, query, cap, tabId) {
  const tab = await findTargetTab(url, tabId);
  if (!tab || tab.id == null) throw noTabError(url);
  if (tab.status !== "complete") await waitForTabReady(tab.id);
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectPageInPage, args: [query || "", Number(cap) || 80] });
  return (res && res.result) || { url: tab.url || "", title: tab.title || "", count: 0, elements: [] };
}

/** Исполняется ВНУТРИ страницы: собрать интерактивные элементы + устойчивые селекторы (self-contained). */
function inspectPageInPage(query, cap) {
  cap = cap > 0 ? cap : 80;
  const q = String(query || "").toLowerCase();
  const lc = (s) => String(s || "").toLowerCase();
  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getClientRects();
    if (!r || !r.length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    const b = el.getBoundingClientRect();
    return b.width > 1 && b.height > 1;
  };
  const SEL =
    'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],' +
    '[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],' +
    '[role="combobox"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"]),[aria-label]';
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\\]]/g, "\\$&"));
  const stableId = (id) => id && /^[A-Za-z][\w-]*$/.test(id) && !/\d{4,}/.test(id) && !/[a-f0-9]{8,}/i.test(id);
  // Устойчивый селектор: id → data-* → aria-label → name/placeholder → короткий nth-of-type. БЕЗ хеш-классов.
  const selFor = (node) => {
    if (stableId(node.getAttribute("id"))) return "#" + esc(node.getAttribute("id"));
    for (const a of ["data-test-id", "data-testid", "data-marker", "data-qa", "data-test"]) {
      const v = node.getAttribute(a);
      if (v) return node.tagName.toLowerCase() + "[" + a + '="' + esc(v) + '"]';
    }
    const al = node.getAttribute("aria-label");
    if (al) return node.tagName.toLowerCase() + '[aria-label="' + esc(al) + '"]';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) {
      const nm = node.getAttribute("name");
      if (nm) return node.tagName.toLowerCase() + '[name="' + esc(nm) + '"]';
      const ph = node.getAttribute("placeholder");
      if (ph) return node.tagName.toLowerCase() + '[placeholder="' + esc(ph) + '"]';
    }
    const parts = [];
    let n = node;
    let d = 0;
    while (n && n.nodeType === 1 && d < 4) {
      let seg = n.tagName.toLowerCase();
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === n.tagName);
        seg += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
      }
      parts.unshift(seg);
      if (seg[0] === "#" || /\[(data-|aria-label|name)/.test(seg)) break;
      n = p;
      d += 1;
    }
    return parts.join(" > ");
  };
  let nodes;
  try {
    nodes = document.querySelectorAll(SEL);
  } catch {
    nodes = [];
  }
  const seen = new Set();
  const out = [];
  let truncated = false;
  for (const el of nodes) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!visible(el)) continue;
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const aria = el.getAttribute("aria-label") || "";
    const text = (el.innerText || el.value || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (q && !(lc(text) + " " + lc(aria) + " " + lc(role)).includes(q)) continue;
    if (out.length >= cap) {
      truncated = true;
      break;
    }
    out.push({
      idx: out.length,
      tag: el.tagName.toLowerCase(),
      role,
      text,
      aria: aria.slice(0, 80) || null,
      selector: selFor(el),
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      href: el.tagName === "A" ? el.getAttribute("href") : null,
    });
  }
  return { url: location.href, title: document.title || "", count: out.length, truncated, elements: out };
}

/** Выполнить действие В ЦЕЛЕВОЙ вкладке (play/pause/next/click/type/scroll) через chrome.scripting. */
async function tabAct(url, intent, params, tabId) {
  const tab = await findTargetTab(url, tabId);
  if (!tab || tab.id == null) throw noTabError(url);
  if (tab.status !== "complete") await waitForTabReady(tab.id);
  const P = params || {};
  const ptext = String(P.text || "");
  const isShake = /встрях|стряхн|обнов/.test(ptext.toLowerCase());
  // КЛИК (и встряхивание) — через MAIN-world РОБАСТ-клик: React-onClick/Enter минуют Swiper-гейт,
  // который в capture-фазе глушит синтетику (корень «встряхнуть не срабатывает», подтверждено). Остальные
  // интенты (play/pause/next/scroll/type/back/forward) — в ISOLATED через pageActInPage, там это работает.
  if (intent === "click" || intent === "shake" || isShake) {
    const clickParams = { ...P };
    if (intent === "shake" || isShake) {
      clickParams.text = clickParams.text || "встряхнуть";
      clickParams.expectChange = true; // встряхивание подтверждаем по реальной смене контента (честность)
    }
    // НЕ активируем вкладку, мышь не трогаем; world:MAIN — чтобы видеть React-props страницы (CSP-safe: функция статична).
    const [resC] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: robustClickMain, args: [clickParams] });
    const rc = (resC && resC.result) || { ok: false, error: "executeScript без результата" };
    if (!rc.ok) throw new Error("tab.act click: " + (rc.error || "не вышло"));
    return rc;
  }
  // PLAY/PAUSE — точечно В ЭТОЙ вкладке через MAIN-world React-onClick по кнопке плеера. НЕ через
  // системную медиа-клавишу (она глобальная — снимала с паузы YouTube/чужой плеер, реальный баг).
  if (intent === "play" || intent === "pause") {
    const [resM] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: mediaControlMain, args: [intent] });
    const rm = (resM && resM.result) || { ok: false, error: "executeScript без результата" };
    if (!rm.ok) throw new Error("tab.act " + intent + ": " + (rm.error || "не вышло"));
    return rm;
  }
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageActInPage, args: [intent, params] });
  const r = (res && res.result) || { ok: false, error: "executeScript без результата" };
  if (!r.ok) throw new Error("tab.act " + intent + ": " + (r.error || "не вышло"));
  return r;
}

/**
 * Исполняется в MAIN-world (видит React-props страницы). РОБАСТ-клик, минующий Swiper-гейт
 * (preventClicks глушит синтетику в capture-фазе → ни el.click(), ни pointer-цепочка не срабатывают).
 * Порядок: React onClick-проп → Enter (role=button/onKeyDown) → полный pointer. Для встряхивания
 * (expectChange) сверяет, что контент РЕАЛЬНО изменился — иначе честный провал (не врём «готово»).
 * Также «вруби/открой волну» (НЕ встряхнуть) → надёжный переход на Вайб. Функция статична → CSP-safe.
 */
async function robustClickMain(params) {
  const P = params || {};
  const lc = (s) => String(s || "").toLowerCase();
  const t = lc(P.text || "");
  const isShake = /встрях|стряхн|обнов/.test(t);
  if (/yandex/i.test(location.host) && !isShake && /(волна|вайб|vibe)/.test(t)) {
    const onVibe = /\/vibe\b/.test(location.pathname) || location.pathname === "/";
    if (!onVibe) {
      location.href = "https://music.yandex.ru/";
      return { ok: true, navigated: "vibe", note: "перешёл на «Мою волну» (Вайб); дальше play" };
    }
    return { ok: true, already: "vibe", note: "уже на «Моей волне»; нужен play" };
  }
  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getClientRects();
    if (!r || !r.length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    const b = el.getBoundingClientRect();
    return b.width > 1 && b.height > 1;
  };
  // РОБАСТ-матч по тексту (зеркало packages/shared/src/ui-match.ts bestTextMatch): голый .includes()
  // цеплял ложь — «удалить».includes(«да») → клик НЕ ТУДА. fold + короткий запрос (≤3) только точно/словом.
  const foldTxt = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[.,!?;:()"'«»\-—–]+/g, " ").replace(/\s+/g, " ").trim();
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scoreText = (q, hay) => {
    if (!q || !hay) return 0;
    if (hay === q) return 100;
    if (new RegExp("(^| )" + escRe(q) + "( |$)").test(hay)) return 80;
    const short = q.length <= 3;
    if (!short && hay.startsWith(q)) return 60;
    if (!short && q.length >= 4 && hay.includes(q)) return 30;
    return 0;
  };
  const resolve = () => {
    if (P.selector) {
      try {
        return document.querySelector(P.selector);
      } catch {
        return null;
      }
    }
    const q = foldTxt(P.text || "");
    if (!q) return null;
    let best = null;
    let bestScore = 0;
    for (const e of document.querySelectorAll("a,button,[role=button],[role=link],[role=tab],[aria-label],[data-test-id],[tabindex]")) {
      if (!(document.contains(e) && !(e.closest && e.closest(".swiper-slide-duplicate")) && visible(e))) continue;
      const s = scoreText(q, foldTxt((e.innerText || "") + " " + (e.getAttribute("aria-label") || "") + " " + (e.title || "")));
      if (s > bestScore) { bestScore = s; best = e; }
    }
    return best;
  };
  let node = resolve();
  if (!node && P.text) {
    for (let i = 0; i < 6 && !node; i += 1) {
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      await new Promise((r) => setTimeout(r, 180));
      node = resolve();
    }
    if (!node) {
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 120));
      node = resolve();
    }
  }
  if (!node) return { ok: false, error: "элемент «" + (P.selector || P.text || "") + "» не найден" };
  const target = (node.closest && node.closest("button,[role=button],a,[role=link],[tabindex]")) || node;
  try {
    target.scrollIntoView({ block: "center" });
  } catch {
    /* ignore */
  }
  const sigOf = () => {
    const m = document.querySelector("main,[class*='Vibe'],[role=main]") || document.body;
    return ((m && m.innerText) || "").replace(/[\d:.,]+/g, "").replace(/\s+/g, " ").trim().slice(0, 4000);
  };
  const before = P.expectChange ? sigOf() : null;

  const reactClick = () => {
    for (let n = target; n; n = n.parentElement) {
      const key = Object.keys(n).find((k) => k.startsWith("__reactProps$"));
      const props = key && n[key];
      if (props && typeof props.onClick === "function") {
        props.onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: {}, currentTarget: n, target: n, bubbles: true, type: "click" });
        return true;
      }
    }
    return false;
  };
  const pressEnter = () => {
    try {
      target.focus();
    } catch {
      /* ignore */
    }
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", o));
    target.dispatchEvent(new KeyboardEvent("keyup", o));
    return true;
  };
  const pointer = () => {
    const r = target.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const ty of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        const C = ty.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
        target.dispatchEvent(new C(ty, o));
      } catch {
        /* ignore */
      }
    }
    try {
      target.click();
    } catch {
      /* ignore */
    }
    return true;
  };

  const methods = [
    { name: "react", fn: reactClick },
    { name: "enter", fn: pressEnter },
    { name: "pointer", fn: pointer },
  ];
  let used = null;
  for (const m of methods) {
    let fired = false;
    try {
      fired = m.fn();
    } catch {
      fired = false;
    }
    if (fired && !used) used = m.name;
    if (P.expectChange) {
      await new Promise((r) => setTimeout(r, 700));
      if (sigOf() !== before) return { ok: true, method: m.name, changed: true };
    } else if (fired) {
      return { ok: true, method: m.name }; // без проверки исхода — первый сработавший способ
    }
  }
  if (P.expectChange) {
    return { ok: false, error: "действие не дало эффекта: перепробовал React-onClick, Enter и клик, но контент не изменился (возможно, кнопка не та или волна неактивна)" };
  }
  return used ? { ok: true, method: used } : { ok: false, error: "не удалось кликнуть по «" + (P.selector || P.text || "") + "»" };
}

/**
 * Исполняется в MAIN-world: play/pause ТОЧЕЧНО в ЭТОЙ вкладке (кнопка плеера по aria-label), через
 * React-onClick (минует Swiper/гейты + точнее синтетики). Идемпотентно (не трогаем, если уже в нужном
 * состоянии), с проверкой исхода. НЕ глобальная медиа-клавиша → не заденет YouTube/другой плеер.
 */
async function mediaControlMain(intent) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lc = (s) => String(s || "").toLowerCase();
  const click = (el) => {
    // React onClick (точно, минует гейты) → иначе нативный click.
    for (let n = el; n; n = n.parentElement) {
      const key = Object.keys(n).find((k) => k.startsWith("__reactProps$"));
      const props = key && n[key];
      if (props && typeof props.onClick === "function") {
        try {
          props.onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: {}, currentTarget: n, target: n, type: "click" });
          return;
        } catch {
          /* ниже нативный */
        }
      }
    }
    try {
      el.click();
    } catch {
      /* ignore */
    }
  };
  // Медиа-элемент (MSE тоже его использует) и mediaSession — ИСТИНА состояния, а НЕ первая кнопка
  // (на Я.Музыке плитки колеса тоже имеют aria «Воспроизведение» → раньше читал не ту и врал «на паузе»).
  const m = document.querySelector("audio, video");
  const sess = () => {
    try {
      return navigator.mediaSession && navigator.mediaSession.playbackState;
    } catch {
      return null;
    }
  };
  // Глобальная кнопка «Пауза» (есть ТОЛЬКО когда играет глобальный плеер; плитки её не показывают).
  const pauseBtn = () => [...document.querySelectorAll("button,[role=button]")].find((b) => ["пауза", "pause"].includes(lc(b.getAttribute("aria-label"))));
  // Глобальная кнопка play — НЕ из колеса/карусели (иначе попадём в плитку, а не в плеер).
  const playBtn = () =>
    [...document.querySelectorAll("button,[role=button]")].find(
      (b) => ["воспроизвести", "воспроизведение", "play", "слушать"].includes(lc(b.getAttribute("aria-label"))) && !(b.closest && b.closest('.swiper, .swiper-slide-duplicate, [class*="Wheel"], [class*="wheel"]')),
    );
  const realPlaying = () => {
    if (m) return !m.paused; // ground truth
    const s = sess();
    if (s === "playing") return true;
    if (s === "paused") return false;
    return Boolean(pauseBtn()); // фолбэк: играющий глобальный плеер показывает «Пауза»
  };

  const playing = realPlaying();
  if (intent === "play" && playing) return { ok: true, already: true, playing: true, state: "playing" };
  if (intent === "pause" && !playing) return { ok: true, already: true, playing: false, state: "paused" };

  if (intent === "pause") {
    if (m) {
      try {
        m.pause();
      } catch {
        /* ignore */
      }
      await sleep(200);
    }
    if (realPlaying()) {
      const b = pauseBtn();
      if (b) click(b);
      await sleep(500);
    }
    return !realPlaying() ? { ok: true, playing: false } : { ok: false, error: "не смог поставить на паузу — ни медиа-элемент, ни кнопка «Пауза» не отреагировали" };
  }
  // play
  if (m) {
    try {
      await m.play();
    } catch {
      /* autoplay/нет жеста — ниже попробуем кнопку */
    }
    await sleep(300);
  }
  if (!realPlaying()) {
    const b = playBtn();
    if (b) click(b);
    await sleep(600);
  }
  return realPlaying()
    ? { ok: true, playing: true }
    : { ok: false, autoplayBlocked: true, error: "play не запустил звук — вкладке плеера, похоже, нужен разовый живой клик (autoplay). Глобальную клавишу не жму, чтобы не задеть другой плеер." };
}

/** Исполняется ВНУТРИ страницы: вернуть читаемый текст. */
function readPageInPage() {
  const main = document.querySelector("main, article, [role=main]") || document.body;
  const text = ((main && main.innerText) || "").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000);
  return { title: document.title || "", url: location.href, text };
}

/** Исполняется ВНУТРИ страницы: действие по интенту (self-contained, без внешних ссылок). async — play ждёт исход. */
async function pageActInPage(intent, params) {
  const P = params || {};
  const lc = (s) => String(s || "").toLowerCase();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getClientRects();
    if (!r || !r.length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    const b = el.getBoundingClientRect();
    return b.width > 1 && b.height > 1;
  };
  // РОБАСТ-матч по тексту (зеркало packages/shared/src/ui-match.ts bestTextMatch): голый .includes()
  // давал ложные попадания — «удалить».includes(«да»)===true → «нажми да» кликало «Удалить». fold
  // (регистр/пунктуация/ё) с обеих сторон; короткий запрос (≤3 симв.) — ТОЛЬКО точно/целым словом
  // (никакой подстроки), подстрока — лишь для запросов ≥4. Скоринг: точное>слово>префикс>подстрока.
  const foldTxt = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[.,!?;:()"'«»\-—–]+/g, " ").replace(/\s+/g, " ").trim();
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scoreText = (q, hay) => {
    if (!q || !hay) return 0;
    if (hay === q) return 100; // точное
    if (new RegExp("(^| )" + escRe(q) + "( |$)").test(hay)) return 80; // целое слово
    const short = q.length <= 3;
    if (!short && hay.startsWith(q)) return 60; // префикс (не для коротких)
    if (!short && q.length >= 4 && hay.includes(q)) return 30; // подстрока — лишь для ≥4
    return 0;
  };
  const byText = (t) => {
    const q = foldTxt(t);
    if (!q) return null;
    let best = null;
    let bestScore = 0;
    for (const e of document.querySelectorAll("a,button,[role=button],[role=link],[role=tab],[aria-label],[data-test-id]")) {
      if (!visible(e)) continue;
      const s = scoreText(q, foldTxt((e.innerText || "") + " " + (e.getAttribute("aria-label") || "") + " " + (e.title || "")));
      if (s > bestScore) { bestScore = s; best = e; }
    }
    return best;
  };
  const media = () => document.querySelector("video, audio");
  // НАСТОЯЩИЙ клик: SPA Яндекса игнорировал синтетический el.click() («страница действие не отдаёт» —
  // прямо из лога). Шлём полную последовательность pointer/mouse-событий по реальной кнопке (closest
  // button/role), как живой указатель — тогда обработчики фреймворка срабатывают.
  const realClick = (node) => {
    const el = (node.closest && node.closest("button,[role=button],a,[role=link],[role=tab]")) || node;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const type of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        const Ctor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, o));
      } catch {
        /* событие не поддержано — пропускаем */
      }
    }
    try {
      if (typeof el.click === "function") el.click();
    } catch {
      /* ignore */
    }
    return el;
  };
  // Глобальная кнопка плеера (Я.Музыка и пр.): матч по aria-label RU+EN. Хэш-классы (__vnoer) волатильны —
  // НЕ хардкодим. Состояние play/pause — по самому aria-label (на Я.Музыке media() = null, стрим через MSE).
  const PLAY_LBL = ["воспроизвести", "воспроизведение", "play", "слушать"];
  const PAUSE_LBL = ["пауза", "pause"];
  const playerBtn = () =>
    [...document.querySelectorAll("button,[role=button]")].find((b) => {
      const a = lc(b.getAttribute("aria-label"));
      return visible(b) && (PLAY_LBL.includes(a) || PAUSE_LBL.includes(a));
    });
  const isPlaying = (b) => {
    if (!b) return false;
    if (PAUSE_LBL.includes(lc(b.getAttribute("aria-label")))) return true; // кнопка показывает «Пауза» = играет
    const u = b.querySelector("svg use");
    const href = u && (u.getAttribute("href") || u.getAttribute("xlink:href"));
    if (href && /#pause/i.test(href)) return true; // вторичный сигнал (часть сборок)
    const m = media();
    return Boolean(m && !m.paused);
  };
  // H1: нативный value-сеттер (прямое el.value= React откатывает на ре-рендере) + input/change.
  const setNativeValue = (el, val) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) setter.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  // H2: поле ввода. С selector — точно; без — ПЕРВОЕ видимое осмысленное поле (НЕ document.body/activeElement).
  const findInput = (sel) => {
    if (sel) return document.querySelector(String(sel));
    const cands = [...document.querySelectorAll('input[type="text"],input[type="search"],input:not([type]),textarea,[contenteditable="true"]')];
    return cands.find((n) => { const b = n.getBoundingClientRect(); return b.width > 1 && b.height > 1 && !n.disabled && !n.readOnly; }) || null;
  };
  // C3: нажать Enter (поиск/сабмит). keydown+keypress+keyup + фолбэк requestSubmit ближайшей формы.
  const pressEnter = (el) => {
    const t = el || document.activeElement;
    if (!t) return false;
    for (const type of ["keydown", "keypress", "keyup"]) {
      t.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    const form = t.form || (t.closest && t.closest("form"));
    if (form) { try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch (e) { /* ignore */ } }
    return true;
  };
  try {
    if (intent === "scroll") { window.scrollBy(0, Number(P.dy) || 600); return { ok: true }; }
    // ПЕРЕМОТКА видео/аудио — через сам медиа-элемент (надёжно на любом плеере, в т.ч. YouTube). НЕ путать
    // с back/forward (это история браузера). seconds — относительно (±), to — абсолютная позиция (сек).
    if (intent === "seek") {
      const m = media();
      if (!m) return { ok: false, error: "на странице нет видео/аудио для перемотки" };
      const to = Number(P.to);
      const sec = Number(P.seconds);
      const dur = Number.isFinite(m.duration) ? m.duration : Infinity;
      if (Number.isFinite(to)) m.currentTime = Math.min(Math.max(0, to), dur);
      else m.currentTime = Math.min(Math.max(0, m.currentTime + (Number.isFinite(sec) ? sec : 10)), dur);
      return { ok: true, currentTime: Math.round(m.currentTime), duration: Number.isFinite(m.duration) ? Math.round(m.duration) : null };
    }
    // back/forward: если на странице есть видео/аудио — это ПЕРЕМОТКА (а не история браузера).
    if (intent === "back" || intent === "forward") {
      const m = media();
      if (m && Number.isFinite(m.duration) && m.duration > 0) {
        const dur = m.duration;
        m.currentTime = Math.min(Math.max(0, m.currentTime + (intent === "forward" ? 10 : -10)), dur);
        return { ok: true, via: "seek", currentTime: Math.round(m.currentTime) };
      }
      if (intent === "back") history.back();
      else history.forward();
      return { ok: true, via: "history" };
    }
    if (intent === "play") {
      // «воспроизвед» — общий стем (ловит и «Воспроизведение», и «Воспроизвести»); + central-кнопку Вайба.
      const btn = playerBtn() || byText("воспроизвед") || byText("play") || byText("слушать") || byText("включить");
      if (!btn) { const m = media(); if (m) { m.play(); return { ok: true, via: "media" }; } return { ok: false, error: "не нашёл кнопку плеера на странице" }; }
      if (isPlaying(btn)) return { ok: true, already: true, playing: true }; // уже играет — НЕ кликаем (иначе пауза)
      realClick(btn);
      // Проверка ИСХОДА: aria-label флипнется на «Пауза», если звук реально пошёл (autoplay-гейт пройден).
      await new Promise((r) => setTimeout(r, 700));
      if (isPlaying(playerBtn() || btn)) return { ok: true, playing: true };
      return {
        ok: false,
        autoplayBlocked: true,
        error: "клик по play прошёл, но воспроизведение не началось — вкладке плеера, похоже, нужен один живой клик пользователя (autoplay браузера блокирует программный старт)",
      };
    }
    if (intent === "pause") {
      const btn = playerBtn() || byText("пауза") || byText("pause");
      if (!btn) { const m = media(); if (m) { m.pause(); return { ok: true, via: "media" }; } return { ok: false, error: "не нашёл кнопку плеера" }; }
      if (!isPlaying(btn)) return { ok: true, already: true, playing: false }; // уже на паузе — НЕ кликаем
      btn.click();
      return { ok: true, playing: false };
    }
    if (intent === "next" || intent === "prev") {
      const labels = intent === "next" ? ["след", "next", "вперёд"] : ["пред", "prev", "назад"];
      const btn = [...document.querySelectorAll("button,[role=button],a")].find((e) => {
        const s = lc(e.getAttribute("aria-label")) + lc(e.title) + lc(e.innerText);
        return visible(e) && labels.some((l) => s.includes(l));
      });
      if (btn) { btn.click(); return { ok: true }; }
      const m = media(); if (m) { m.currentTime += intent === "next" ? 10 : -10; return { ok: true }; }
      return { ok: false, error: "не нашёл переключение трека" };
    }
    if (intent === "click") {
      const t = lc(P.text || "");
      // «Встряхнуть/стряхнуть/обновить волну» — это ДЕЙСТВИЕ (кнопка на странице), НЕ навигация. Важно
      // отделить от «вруби/открой волну», иначе клик «встряхнуть» ложно срабатывал как переход на Вайб
      // и возвращал ok → модель врала «встряхнул» (реальный баг из лога).
      const isShake = /встрях|стряхн|обнов/.test(t);
      // ВЕРИФИЦИРУЕМОЕ встряхивание: клика мало (возвращал ok за факт клика → враньё «обновилась»).
      // Жмём кнопку и СВЕРЯЕМ, реально ли изменилась подборка. Не изменилась → ЧЕСТНЫЙ провал (не ok),
      // тогда и навык по ложному успеху не сохранится.
      if (isShake) {
        const findShake = () => byText("встряхнуть") || byText("стряхнуть") || byText("обновить волну") || byText("обновить");
        let sb = findShake();
        for (let i = 0; i < 8 && !sb; i += 1) {
          window.scrollBy(0, Math.round(window.innerHeight * 0.85));
          await new Promise((r) => setTimeout(r, 200));
          sb = findShake();
        }
        if (!sb) return { ok: false, error: "не нашёл кнопку «Встряхнуть» на странице (даже прокрутив вниз)" };
        // Подпись содержимого волны (плитки/треки), время и цифры выкидываем — иначе тикающий таймер трека даёт ложное «изменилось».
        const sig = () => {
          const main = document.querySelector("main, [class*='VibePage'], [class*='Vibe'], [role=main]") || document.body;
          return ((main && main.innerText) || "").replace(/[\d:.,]+/g, "").replace(/\s+/g, " ").trim().slice(0, 4000);
        };
        const before = sig();
        realClick(sb);
        await new Promise((r) => setTimeout(r, 1000));
        if (sig() === before) {
          return { ok: false, error: "нажал «Встряхнуть», но подборка НЕ изменилась — вероятно, волна на паузе (встряхивание тасует подборку только у активной/играющей волны). Сменить звучащий трек — это «следующий трек»." };
        }
        return { ok: true, changed: true, note: "встряхнул — подборка реально обновилась (сверено до/после)" };
      }
      // Я.Музыка: «вруби/открой мою волну» — клик по пункту меню капризно НЕ переключает SPA → форсим
      // переход на страницу Вайба (там живёт «Моя волна»). Дальше модель отдельным play запускает звук.
      if (/yandex/i.test(location.host) && !isShake && /(волна|вайб|vibe)/.test(t)) {
        const onVibe = /\/vibe\b/.test(location.pathname) || location.pathname === "/";
        if (!onVibe) { location.href = "https://music.yandex.ru/"; return { ok: true, navigated: "vibe", note: "перешёл на «Мою волну» (Вайб); теперь play" }; }
        return { ok: true, already: "vibe", note: "уже на «Моей волне»; нужен play" };
      }
      const finder = () => (P.selector ? document.querySelector(String(P.selector)) : byText(P.text));
      let el = finder();
      if (!el) {
        // ОБЩЕЕ «оглядеться» (НЕ хардкод под конкретную кнопку): элемент может быть ниже сгиба или
        // лениво дорисовываться при прокрутке. Скроллим страницу шагами и переищем после каждого —
        // так находим что угодно внизу (та же «встряхнуть»), без жёсткой инструкции «тут мотай вниз».
        for (let i = 0; i < 8 && !el; i += 1) {
          window.scrollBy(0, Math.round(window.innerHeight * 0.85));
          await new Promise((r) => setTimeout(r, 200));
          el = finder();
        }
        if (!el) { window.scrollTo(0, 0); await new Promise((r) => setTimeout(r, 150)); el = finder(); }
      }
      if (!el) return { ok: false, error: "элемент «" + (P.selector || P.text || "") + "» не найден даже после прокрутки страницы" };
      realClick(el);
      return { ok: true };
    }
    if (intent === "type") {
      const el = findInput(P.selector);
      if (!el) return { ok: false, error: "поле ввода не найдено — укажи selector (browser_inspect показывает поля)" };
      el.focus();
      const v = String(P.text ?? "");
      if (el.isContentEditable) {
        el.textContent = "";
        if (document.execCommand) document.execCommand("insertText", false, v);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: v }));
      } else {
        setNativeValue(el, v); // H1: нативный сеттер — держится на React-инпутах
      }
      // C3: ввод+поиск за один вызов, если просили {enter:true} / {submit:true}
      const submitted = P.enter || P.submit ? pressEnter(el) : false;
      return { ok: true, typed: v.slice(0, 60), submitted };
    }
    if (intent === "enter" || intent === "submit") {
      // C3: нажать Enter / отправить форму (запустить поиск после type). selector опционален.
      const el = P.selector ? document.querySelector(String(P.selector)) : document.activeElement;
      pressEnter(el || document.activeElement);
      return { ok: true, submitted: true };
    }
    return { ok: false, error: "неизвестный intent: " + intent };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Открыть URL в ТВОЁМ браузере (твоя сессия/логин) С УЧЁТОМ уже открытых вкладок:
 * если вкладка того же сервиса уже есть — ФОКУСИРУЕМ её (не плодим дубль), иначе открываем новую.
 * Это решает «постоянно новые вкладки»: Джарвис видит, что открыто (chrome.tabs.query), и не дублирует.
 */
async function openOrFocus(url) {
  if (!url) throw new Error("нужен url");
  const host = hostOf(url);
  const tabs = await chrome.tabs.query({});
  const match = host ? tabs.find((t) => hostOf(t.url || "") === host) : null;
  if (match && match.id != null) {
    // Запрошен КОНКРЕТНЫЙ URL (путь/запрос — /results?search_query=…, /watch?v=…), а вкладка стоит на
    // ДРУГОЙ странице → НАВИГИРУЕМ её на этот URL. Иначе был баг «фокус без перехода»: поиск/страница
    // не открывались (фокусили старую вкладку хоста), а Джарвис рапортовал успех («ты ничего не вводишь
    // в поиск» = ложь). Голый хост (homepage) → просто фокус, не перезагружаем (анти-дубль вкладок).
    const want = urlPathQuery(url);
    const have = urlPathQuery(match.url || "");
    if (want !== "/" && want !== have) {
      await chrome.tabs.update(match.id, { active: true, url });
      await raiseWindow(match.windowId);
      return { navigated: true, tabId: match.id, url };
    }
    // Вкладку активной + окно Chrome НА ПЕРЕДНИЙ ПЛАН: browser_open = «открой/покажи», Джарвис САМ берёт
    // фокус, чтобы пользователь увидел результат — пользователь НЕ фокусит руками. (Фоновые действия идут
    // через browser_act{tabId} — те окно не трогают.)
    await chrome.tabs.update(match.id, { active: true });
    await raiseWindow(match.windowId);
    return { focused: true, tabId: match.id, url: match.url || url };
  }
  const tab = await chrome.tabs.create({ url, active: true });
  await raiseWindow(tab.windowId);
  return { created: true, tabId: tab.id, url };
}

/** Вывести окно Chrome на ПЕРЕДНИЙ ПЛАН (Джарвис сам берёт фокус для «покажи» — пользователь не фокусит руками). */
async function raiseWindow(windowId) {
  if (windowId == null) return;
  try {
    await chrome.windows.update(windowId, { focused: true, drawAttention: true });
  } catch (e) {
    /* окно закрыто/недоступно — не критично */
  }
}

/**
 * Перечислить ОТКРЫТЫЕ вкладки твоего браузера (chrome.tabs.query) — чтобы Джарвис понял, о какой
 * вкладке ты говоришь («та, где ютуб», «где играет музыка», «эта»). Отдаём заголовок/URL/активна/
 * звучит ли — по ним модель сопоставит твою фразу с конкретной вкладкой. Только чтение списка.
 */
async function tabList() {
  const tabs = await chrome.tabs.query({});
  const list = tabs
    .filter((t) => t.id != null && !(t.url || "").startsWith("chrome://"))
    .map((t) => ({
      tabId: t.id,
      title: (t.title || "").slice(0, 120),
      url: t.url || "",
      host: hostOf(t.url || ""),
      active: !!t.active, // активная в своём окне
      audible: !!t.audible, // играет звук — для «вкладка с музыкой/видео»
      windowId: t.windowId,
    }))
    // звучащие и активные — выше: про них чаще спрашивают («поставь паузу там, где играет»).
    .sort((a, b) => Number(b.audible) - Number(a.audible) || Number(b.active) - Number(a.active));
  return { tabs: list, count: list.length };
}

/**
 * Закрыть вкладку(и): по tabId (точно, из browser_tabs) → по хосту url (все вкладки этого сайта) →
 * активную. chrome.tabs.remove. Возвращает, сколько закрыто. chrome:// и страницы расширения не трогаем.
 */
async function tabClose(url, tabId) {
  let ids = [];
  if (tabId != null) {
    ids = [Number(tabId)];
  } else {
    const host = hostOf(url);
    const tabs = await chrome.tabs.query({});
    if (host) {
      ids = tabs.filter((t) => t.id != null && hostOf(t.url || "") === host).map((t) => t.id);
    } else {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active && active.id != null && !(active.url || "").startsWith("chrome://")) ids = [active.id];
    }
  }
  if (!ids.length) throw new Error(url ? "вкладка " + (hostOf(url) || url) + " не найдена" : "нет вкладки для закрытия");
  await chrome.tabs.remove(ids);
  return { closed: ids.length, tabIds: ids };
}

/**
 * Получить вкладку web.telegram.org для инжекта (§6). КЛЮЧЕВОЕ: фоновое/перекрытое окно Chrome
 * помечает visibilityState=hidden → rAF на паузе → webK НЕ рендерится (висит на has-auth-pages с
 * пустым телом, хотя сессия есть). Поэтому:
 *  1) если у пользователя УЖЕ открыт web.telegram.org — берём ЕГО вкладку (DOM уже построен,
 *     залогинен; инжект работает даже если она в фоне — элементы существуют). Без вспышки.
 *  2) иначе создаём ВИДИМОЕ окно (focused:true) — только так webK поднимется и отрендерит UI;
 *     закрываем после отправки. Краткая вспышка — плата за то, что вообще работает.
 * Возвращает { tabId, winId, created }.
 */
async function openTgTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ["*://web.telegram.org/k/*", "*://web.telegram.org/a/*", "*://web.telegram.org/*"] });
  } catch { /* ignore */ }
  const existing = (tabs || []).find((t) => t.status === "complete") || (tabs || [])[0];
  if (existing && existing.id != null) {
    // КЛЮЧЕВОЕ: фоновая вкладка → Chrome ставит rAF webK на паузу → операция стопорится (таймаут).
    // На время отправки делаем вкладку АКТИВНОЙ и фокусим окно — webK оживает, операция идёт быстро.
    try { await chrome.tabs.update(existing.id, { active: true }); } catch { /* ignore */ }
    try { if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 900)); // дать webK возобновить рендер
    return { tabId: existing.id, winId: existing.windowId, created: false };
  }
  // Нет открытой вкладки → ВИДИМОЕ окно (иначе webK не отрисуется).
  const win = await chrome.windows.create({ url: "https://web.telegram.org/k/", focused: true, type: "normal", left: 80, top: 80, width: 560, height: 820 });
  const tab = win && win.tabs && win.tabs[0];
  if (!tab) { try { if (win) await chrome.windows.remove(win.id); } catch { /* ignore */ } throw new Error("не удалось открыть окно"); }
  await waitTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 3500)); // webK холодный старт + восстановление сессии
  return { tabId: tab.id, winId: win.id, created: true };
}

/** Закрыть окно Telegram, только если МЫ его создавали (вкладку пользователя не трогаем). */
async function closeTgTab(h) {
  if (h && h.created && h.winId != null) { try { await chrome.windows.remove(h.winId); } catch { /* ignore */ } }
}

/**
 * Отправить сообщение в Telegram через web.telegram.org/k/ (твоя залогиненная сессия).
 * Берём существующую вкладку или открываем видимое окно (см. openTgTab) → инжект → результат.
 */
async function telegramSend(to, text, variants) {
  if (!to || !text) throw new Error("нужны to и text");
  const ka = startKeepAlive(); // SW не должен умереть на время операции
  const h = await openTgTab();
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: h.tabId }, func: tgSendInPage, args: [to, text, Array.isArray(variants) ? variants : []] });
    const res = (results && results[0] && results[0].result) || { ok: false, step: "no-result", error: "executeScript без результата" };
    if (!res.ok) {
      const dom = res.dom ? " | DOM=" + JSON.stringify(res.dom) : "";
      throw new Error("telegram: " + res.step + ": " + res.error + dom);
    }
    return res;
  } finally {
    clearInterval(ka);
    await closeTgTab(h);
  }
}

/**
 * Отправить ГОЛОСОВОЕ (кружок) в Telegram через web.telegram.org/k/ голосом филиппа. Без VB-CABLE и
 * без API-ключей: в MAIN-world подменяем getUserMedia на поток из TTS-аудио и жмём запись webK →
 * Telegram запишет наш голос как настоящее голосовое. audioB64 — mp3 TTS (синтез на сервере).
 */
async function telegramSendVoice(to, audioB64) {
  if (!to || !audioB64) throw new Error("нужны to и audioB64");
  // НЕ РЕАЛИЗОВАНО (честный отказ вместо ReferenceError): файловый инжектор `tgSendFileInPage` так и не
  // написан — прежний путь (подмена getUserMedia + запись голосового в webK) был медленным (60-80с) и
  // умирал вместе с MV3 service worker («расширение не ответило»), его сняли, а замену не сделали.
  // Раньше эта функция звала несуществующую tgSendFileInPage → крах «tgSendFileInPage is not defined»
  // на каждом telegram.send_voice. Возвращаем ЯВНУЮ причину — сервер озвучит «не вышло», а не соврёт.
  throw new Error("telegram: голосовая отправка не реализована (нет файлового инжектора)");
}

/** DEV-диагностика: поиск по query, дамп СТРУКТУРЫ результатов (БЕЗ открытия/отправки). */
async function telegramDiag(query) {
  const ka = startKeepAlive();
  const h = await openTgTab();
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: h.tabId }, func: tgDiagInPage, args: [query] });
    return (results && results[0] && results[0].result) || { ok: false, error: "нет результата" };
  } finally {
    clearInterval(ka);
    await closeTgTab(h);
  }
}

/**
 * §проактив-всё: НЕПРОЧИТАННЫЕ чаты Telegram НЕИНВАЗИВНО — из УЖЕ открытой вкладки web.telegram.org, БЕЗ
 * создания/фокуса (ambient не дёргает пользователя). Нет открытой вкладки → {ok:true, noTab:true}. DOM-снимок
 * списка диалогов с числовым бейджем непрочитанного. ⚠️ селекторы webK — калибровать на ЖИВОМ Telegram.
 */
async function telegramUnread() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ["*://web.telegram.org/k/*", "*://web.telegram.org/a/*", "*://web.telegram.org/*"] });
  } catch (e) { return { ok: false, error: "tabs.query: " + (e && e.message) }; }
  const tab = tabs.find((t) => t.id !== undefined);
  if (!tab) return { ok: true, noTab: true, unread: [] }; // нет вкладки → не лезем (неинвазивно)
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: tgUnreadInPage });
    return (results && results[0] && results[0].result) || { ok: false, error: "нет результата" };
  } catch (e) {
    return { ok: false, error: "scripting: " + (e && e.message) };
  }
}

/** Внутри webK (self-contained): собрать непрочитанные диалоги с числовым бейджем (заглушённые помечаем muted). */
function tgUnreadInPage() {
  try {
    const rows = [...document.querySelectorAll('ul.chatlist a.chatlist-chat, .chatlist a.chatlist-chat, a.chatlist-chat, li.chatlist-chat')];
    const seen = new Set();
    const unread = [];
    for (const el of rows) {
      // числовой бейдж непрочитанного (не реакция/упоминание без числа)
      const badgeEl = el.querySelector('.dialog-subtitle-badge, .badge-unread, [class*="badge" i]');
      const count = badgeEl ? parseInt((badgeEl.textContent || "").replace(/\D+/g, ""), 10) : NaN;
      if (!Number.isFinite(count) || count <= 0) continue;
      const tn = el.querySelector(".peer-title, .user-title");
      const title = ((tn ? tn.textContent : "") || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!title || seen.has(title)) continue;
      seen.add(title);
      const prevEl = el.querySelector(".user-last-message, .peer-last-message, .dialog-subtitle, .row-subtitle");
      const preview = ((prevEl ? prevEl.textContent : "") || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const muted = /muted|is-muted/i.test(el.className) || el.querySelector(".is-muted, [class*='muted' i]") != null;
      const a = el.matches("a[href]") ? el : el.querySelector("a[href]");
      const href = (a && a.getAttribute("href")) || "";
      const peerId = (href.replace(/[^a-zA-Z0-9_-]/g, "") || title).slice(0, 40);
      unread.push({ title, count, preview, muted: Boolean(muted), peerId });
    }
    return { ok: true, unread, total: unread.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), unread: [] };
  }
}

/** Внутри webK: ввести query в поиск и вернуть строки-результаты с КОНТЕКСТОМ ГРУППЫ (диалоги vs глобальный/каналы). */
function tgDiagInPage(query) {
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 1 && b.height > 1; };
    const setInput = (el, val) => {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
      if (setter) setter.call(el, val); else el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const realClick = (el) => { try { ["pointerdown","mousedown","pointerup","mouseup","click"].forEach((t)=>el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}))); } catch (e) {} };
    const findSearch = () => {
      const known = ['.input-search input', 'input.input-search-input', '#column-left input.input-field-input', '.sidebar-header input'];
      for (const s of known) { const el = document.querySelector(s); if (el && visible(el)) return el; }
      return [...document.querySelectorAll('input[type="text"], input:not([type])')].find((el) => visible(el)
        && /search|поиск/i.test((el.getAttribute("placeholder")||"")+(el.getAttribute("aria-label")||""))) || null;
    };
    const waitFor = async (fn, ms) => { const end = Date.now()+ms; while (Date.now()<end) { const v = fn(); if (v) return v; await sleep(300); } return null; };
    (async () => {
      const url = location.href;
      await waitFor(() => document.querySelector(".chatlist, ul.chatlist, #folders-container"), 15000);
      // ДАМП поисковой зоны: все видимые input/textarea + элементы с 'search' в class/id — увидеть реальную разметку.
      const inputs = [...document.querySelectorAll("input, textarea")].filter(visible).map((el) => ({
        tag: el.tagName, type: el.getAttribute("type") || "", id: el.id || "", cls: el.className.slice(0, 70),
        ph: el.getAttribute("placeholder") || "", aria: el.getAttribute("aria-label") || "",
      }));
      const searchish = [...document.querySelectorAll('[class*="search" i],[id*="search" i]')].filter(visible).slice(0, 12).map((el) => ({
        tag: el.tagName, id: el.id || "", cls: el.className.slice(0, 70),
      }));
      const search = await waitFor(findSearch, 4000);
      if (!search) return resolve({ ok: false, error: "нет поля поиска", url, inputs, searchish });
      realClick(search); search.focus(); setInput(search, query);
      // ждём появления результатов (любой группы)
      await waitFor(() => document.querySelector('.search-group, a.chatlist-chat, .search-super'), 8000);
      await sleep(1500); // settle — догрузить глобальные
      const rowSel = 'a.chatlist-chat, li.chatlist-chat, .chatlist-chat, ul.chatlist > a, .search-group a.row, a.row';
      const rows = [...document.querySelectorAll(rowSel)].filter(visible);
      const dump = rows.slice(0, 40).map((el) => {
        const tn = el.querySelector(".peer-title, .user-title");
        const title = ((tn ? tn.textContent : el.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 50);
        const grp = el.closest(".search-group, .search-super-tab-container, section");
        const grpName = grp ? ((grp.querySelector(".search-group__name, .search-super-name, h3, .sidebar-left-section-name") || {}).textContent || grp.className || "").replace(/\s+/g, " ").trim().slice(0, 50) : "";
        const a = el.matches("a[href]") ? el : el.querySelector("a[href]");
        const href = (a && a.getAttribute("href")) || "";
        return { title, group: grpName, href, badge: Boolean(el.querySelector('[class*="badge" i], .dialog-subtitle')) };
      });
      const groups = [...document.querySelectorAll(".search-group")].map((g) => ({ name: ((g.querySelector(".search-group__name, h3") || {}).textContent || "").replace(/\s+/g," ").trim(), cls: g.className.slice(0,60), rows: g.querySelectorAll("a, li").length }));
      resolve({ ok: true, query, url, groupsOrder: groups, rows: dump });
    })();
  });
}

/**
 * Исполняется ВНУТРИ страницы web.telegram.org/k/ (self-contained — без внешних ссылок).
 * Best-effort v1: ищет контакт, открывает чат, печатает, отправляет. Возвращает диагностику.
 */
function tgSendInPage(to, text, variants) {
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // ВИДИМОСТЬ: offsetParent === null для position:fixed/sticky (шапка поиска webK как раз
    // в фикс/трансформ-контейнере) → старая проверка ложно скрывала валидный input. Считаем
    // элемент видимым по геометрии + вычисленным стилям.
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

    // Поле поиска: сперва известные классы webK (input-search-input), затем эвристика по
    // placeholder/aria, затем первый видимый текстовый input в левой колонке.
    const findSearch = () => {
      const known = q(['.input-search input', 'input.input-search-input', '#column-left input.input-field-input', '.sidebar-header input']);
      if (known) return known;
      const inputs = [...document.querySelectorAll('input')].filter(visible);
      const byHint = inputs.find((el) => {
        const h = lc(el.placeholder) + " " + lc(el.getAttribute("aria-label"));
        return h.includes("search") || h.includes("поиск");
      });
      if (byHint) return byHint;
      const left = document.querySelector('#column-left, .sidebar-left, .LeftColumn, [class*="left" i]') || document;
      return [...left.querySelectorAll('input[type="text"], input:not([type]), input.input-field-input')].find(visible) || null;
    };
    // Поле сообщения: известный класс webK input-message-input, затем видимый contenteditable.
    const findMsgInput = () => {
      const known = q(['.input-message-input[contenteditable="true"]', 'div.input-message-input']);
      if (known) return known;
      const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
      return eds.find((el) => {
        const h = lc(el.getAttribute("aria-label")) + " " + lc(el.dataset && el.dataset.placeholder) + " " + lc(el.className);
        return h.includes("message") || h.includes("сообщен") || h.includes("input-message");
      }) || eds[eds.length - 1] || null;
    };
    const waitForFn = async (fn, timeout = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { const el = fn(); if (el) return el; await sleep(200); }
      return null;
    };
    // Диагностика DOM на провале — чтобы поправить селекторы без лишних кругов reload.
    const dumpDom = () => {
      const ins = [...document.querySelectorAll('input')].slice(0, 12).map((e) =>
        `input#${e.id}.${e.className}|ph="${e.placeholder}"|aria="${e.getAttribute("aria-label")}"|type=${e.type}|vis=${visible(e)}`);
      const eds = [...document.querySelectorAll('[contenteditable="true"]')].slice(0, 8).map((e) =>
        `ce#${e.id}.${e.className}|ph="${e.dataset && e.dataset.placeholder}"|aria="${e.getAttribute("aria-label")}"|vis=${visible(e)}`);
      const btns = [...document.querySelectorAll('button')].slice(0, 14).map((e) =>
        `btn.${e.className}|aria="${e.getAttribute("aria-label")}"|vis=${visible(e)}`);
      const authEl = document.querySelector('#auth-pages, .auth-pages, [class*="signIn" i], [class*="sign-in" i], [class*="authCode" i]');
      const hasAuthClass = document.body ? document.body.classList.contains("has-auth-pages") : false;
      const bodyText = (document.body ? document.body.innerText || "" : "").replace(/\s+/g, " ").trim().slice(0, 400);
      return {
        url: location.href,
        title: document.title,
        bodyClass: document.body ? document.body.className : "",
        hasAuthClass,                      // body.has-auth-pages → НЕ залогинен / экран входа
        visibilityState: document.visibilityState, // hidden → фоновая вкладка тормозит рендер
        hasChatlist: Boolean(document.querySelector('.chatlist, ul.chatlist, #folders-container')),
        looksLoggedIn: !authEl && !hasAuthClass,
        inputCount: document.querySelectorAll('input').length,
        ceCount: document.querySelectorAll('[contenteditable="true"]').length,
        bodyText,
        inputs: ins, editables: eds, buttons: btns,
      };
    };
    const setInput = (el, val) => {
      el.focus();
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
    };
    // Полная цепочка указателя — webK-элементы списка реагируют на mousedown/up, не только click.
    const realClick = (el) => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    };

    (async () => {
      try {
        // 0) Не залогинен → дальше бессмысленно, сразу диагностируем.
        await sleep(300);
        const dom0 = dumpDom();
        if (!dom0.looksLoggedIn && !dom0.hasChatlist) {
          // дать ещё шанс догрузиться, потом проверить повторно
          await sleep(2500);
          const d = dumpDom();
          if (!d.looksLoggedIn) return resolve({ ok: false, step: "not-logged-in", error: "похоже, не залогинен в web.telegram.org/k/", dom: d });
        }

        // 1) Поле поиска.
        const search = await waitForFn(findSearch);
        if (!search) return resolve({ ok: false, step: "search-input", error: "не нашёл поле поиска", dom: dumpDom() });
        realClick(search);
        search.focus();
        setInput(search, to);
        await sleep(2200);

        // 2) Результат-чат — по ЗАГОЛОВКУ (имени), НЕ по тексту всей строки. Раньше матчили
        //    el.textContent всей строки = имя + ПРЕВЬЮ последнего сообщения → если у чужого чата
        //    в превью встречалось искомое слово, уходили в «левый контакт». Теперь скорим по имени:
        //    точное > начинается-с > слово > подстрока-в-имени; превью игнорим. Saved=Избранное.
        const wantSaved = /избранн|saved/i.test(to);
        const qy = lc(to);
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const titleOf = (el) => {
          const tEl = el.querySelector(".peer-title") || el.querySelector(".user-title");
          // .peer-title/.user-title — имя чата в webK; нет — берём первую строку, без превью-подзаголовка.
          if (tEl) return lc((tEl.textContent || "").trim());
          const sub = el.querySelector(".dialog-subtitle, .row-subtitle, [class*='subtitle' i]");
          let t = (el.textContent || "");
          if (sub && sub.textContent) t = t.replace(sub.textContent, ""); // выкинуть превью сообщения
          return lc(t.trim());
        };
        // Подзаголовок строки (последнее сообщение / статус / для канала — счётчик подписчиков).
        const subtitleOf = (el) => {
          const sub = el.querySelector(".dialog-subtitle, .row-subtitle, [class*='subtitle' i], .user-last-message");
          return lc((sub && sub.textContent) || "");
        };
        // §Фаза5 (фикс «ищет не по моим диалогам, в каналы хуярит»): получатель = ЧЕЛОВЕК/диалог, НЕ канал.
        // Канал в результатах webK выдаёт себя счётчиком подписчиков в подзаголовке (у юзера — превью/last
        // seen) и broadcast-peerId (#-100…). Существующий диалог (chatlist) приоритетнее глобального поиска.
        const isChannel = (el) => {
          if (/\bsubscriber|подписчик/i.test(subtitleOf(el))) return true;
          const a = el.matches("a[href]") ? el : el.querySelector("a[href]");
          const href = (a && a.getAttribute("href")) || "";
          return /#-100\d/.test(href);
        };
        const isDialog = (el) => el.classList.contains("chatlist-chat") || Boolean(el.closest("#folders-container, ul.chatlist"));
        const scoreOf = (el) => {
          const title = titleOf(el);
          if (wantSaved && (title.includes("saved messages") || title.includes("избранное"))) return 200;
          if (!qy) return 0;
          let s = 0;
          if (title === qy) s = 90;                                 // точное имя
          else if (title.startsWith(qy)) s = 70;                    // начинается с запроса
          else if (new RegExp("\\b" + esc(qy)).test(title)) s = 50; // слово в имени (с границы)
          else if (title.includes(qy)) s = 30;                      // подстрока В ИМЕНИ (не в превью)
          else return 0;                                            // в имени нет → НЕ совпадение
          if (isChannel(el)) s -= 1000;                             // канал под имя человека НЕ выбираем
          if (isDialog(el)) s += 5;                                 // существующий диалог приоритетнее глобального
          return s;
        };
        const findResult = () => {
          const items = [...document.querySelectorAll(
            'a.chatlist-chat, li.chatlist-chat, .chatlist-chat, ul.chatlist > a, ul.chatlist > li, .search-group a.row, a.row.chatlist-chat, [class*="chatlist-chat" i]'
          )].filter(visible);
          let best = null, bestScore = 0; // bestScore=0 → отрицательные (каналы) и несовпадения не выбираются
          for (const el of items) {
            const s = scoreOf(el); // равенство → первый в DOM (существующие чаты раньше глобального поиска)
            if (s > bestScore) { best = el; bestScore = s; }
          }
          return best;
        };
        let result = await waitForFn(findResult, 10000);
        // settle: дать webK догрузить остальные результаты, перевыбрать ЛУЧШИЙ (вдруг точный пришёл позже).
        if (result) { await sleep(500); result = findResult() || result; }
        // Кросс-скрипт (RECALL): контакт мог быть сохранён в ДРУГОМ алфавите (Герман→Herman) — поиск
        // кириллицей его не поднимет. Прогоняем транслит-варианты в поиск, чтобы он ВСПЛЫЛ. Решение,
        // кто настоящий, принимает МОДЕЛЬ: без точного совпадения по `to` вернём кандидатов.
        const collectTitles = () => [...document.querySelectorAll('a.chatlist-chat, li.chatlist-chat, .chatlist-chat, ul.chatlist > a, [class*="chatlist-chat" i]')]
          .filter(visible)
          .map((el) => { const tn = el.querySelector(".peer-title, .user-title"); return ((tn ? tn.textContent : el.textContent) || "").replace(/\s+/g, " ").trim(); })
          .filter(Boolean);
        const candSet = new Set(collectTitles());
        if (!result && Array.isArray(variants)) {
          for (const v of variants) {
            if (!v || lc(v) === lc(to)) continue;
            realClick(search); search.focus(); setInput(search, v);
            await sleep(1800);
            for (const t of collectTitles()) candSet.add(t);
            const r = findResult(); // вдруг вариант дал ТОЧНОЕ совпадение по `to`
            if (r) { result = r; break; }
          }
        }
        if (!result) {
          const candidates = [...candSet].slice(0, 20);
          return resolve({
            ok: false,
            step: "pick-chat",
            error: "не нашёл однозначный чат «" + to + "». Кандидаты: " + (candidates.join(" | ") || "—") + ". Выбери того, кто по смыслу = «" + to + "» (учитывай транслитерацию Герман≈Herman, падежи) и повтори с ТОЧНЫМ именем из списка.",
            candidates,
            dom: dumpDom(),
          });
        }
        const matchedName = ((result.querySelector(".peer-title, .user-title") || {}).textContent || to).trim();
        // Открыть чат НАДЁЖНО: клик по реальной строке-ссылке + НАТИВНЫЙ .click() (webK навигирует
        // по href="#peerId" — синтетических событий мало). Если композер не появился — повтор клика.
        const row = result.closest('a.chatlist-chat, li.chatlist-chat, .chatlist-chat') || result;
        realClick(row);
        try { row.click(); } catch { /* ignore */ }
        let input = await waitForFn(findMsgInput, 4000);
        if (!input) { realClick(row); try { row.click(); } catch { /* ignore */ } input = await waitForFn(findMsgInput, 6000); }

        // 3) Поле ввода сообщения.
        if (!input) return resolve({ ok: false, step: "message-input", error: "не нашёл поле сообщения", dom: dumpDom() });
        input.focus();
        // contenteditable: вставляем текст и шлём input-событие.
        document.execCommand && document.execCommand("insertText", false, text);
        if (!(input.textContent || "").trim()) {
          input.textContent = text;
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        }
        await sleep(700);

        // 4) Отправка: кнопка send или Enter.
        const sendBtn = q(['.btn-send', '.btn-send-container button', 'button.send', '.chat-input .btn-send']);
        if (sendBtn) {
          realClick(sendBtn);
        } else {
          const ev = (type) => input.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
          ev("keydown");
          ev("keypress");
          ev("keyup");
        }
        // 5) ПОДТВЕРДИТЬ: webK очищает поле ввода после успешной отправки. Если поле всё ещё с
        //    текстом — сообщение НЕ ушло (не выдаём ложный успех).
        let sent = false;
        for (let i = 0; i < 15; i += 1) {
          await sleep(200);
          if ((input.textContent || "").trim().length === 0) { sent = true; break; }
        }
        if (!sent) return resolve({ ok: false, step: "send-verify", error: "поле не очистилось — отправка не подтверждена", dom: dumpDom() });
        resolve({ ok: true, to, matched: matchedName, sent: text.slice(0, 40) });
      } catch (e) {
        resolve({ ok: false, step: "exception", error: String((e && e.message) || e) });
      }
    })();
  });
}

// MV3 service worker засыпает — поэтому: коннектим на старте/установке И держим живым
// будильником (chrome.alarms будит SW каждые ~24с → переподключаем, если связь упала).
// Открытый WS сам продлевает жизнь SW (Chrome 116+), будильник — страховка.
connect();
chrome.runtime.onStartup?.addListener(connect);
chrome.runtime.onInstalled?.addListener(connect);
try {
  chrome.alarms.create("jarvis-keepalive", { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(() => {
    // Через единый дебаунс-путь (scheduleReconnect), не дёргаем connect() напрямую —
    // иначе гонка с onclose→scheduleReconnect создаёт два сокета.
    if (!ws || ws.readyState === 2 || ws.readyState === 3) scheduleReconnect();
  });
} catch (e) {
  console.log("[jarvis] alarms недоступны:", e);
}

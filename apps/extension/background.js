/**
 * Jarvis Web Hands — service worker расширения.
 *
 * Связь с сервером Джарвиса по WS (ws://127.0.0.1:8787/ext). Сервер шлёт интенты
 * ({id, type, ...}); расширение исполняет их в ТВОЁМ Chrome на ТВОИХ логинах через
 * ФОНОВУЮ вкладку (active:false) и отвечает {id, ok, data|error}. Никаких новых входов,
 * никакого debug-порта, вкладка в фоне → почти невидимо.
 */

import { sleep, hostOf, urlPathQuery, noTabError, isPrivateHost } from "./modules/utils.js";
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
      ws.onerror = null; // аудит-2 [4]: снимаем и onerror — иначе поздняя ошибка старого сокета закроет НОВЫЙ
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
  // аудит-2 [4]: захватываем ссылку на ЭТОТ сокет — обработчики (особенно onerror) действуют на него,
  // а не на мутабельную модульную `ws`, которая к моменту поздней ошибки может указывать на новый сокет.
  const socket = ws;
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
      socket.close(); // аудит-2 [4]: закрываем СВОЙ сокет, не текущий модульный ws
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
    case "calendar.read":
      return calendarRead(msg.open === true);
    case "mail.read":
      return mailRead(msg.open === true);
    case "telegram.send_voice":
      return telegramSendVoice(String(msg.to || ""), String(msg.audioB64 || ""));
    case "tab.openOrFocus":
      return openOrFocus(String(msg.url || ""));
    case "tab.list":
      return tabList();
    case "tab.close":
      return tabClose(msg.url ? String(msg.url) : "", msg.tabId);
    case "tab.read":
      return tabRead(msg.url ? String(msg.url) : "", msg.tabId, msg.query ? String(msg.query) : "");
    case "tab.inspect":
      return tabInspect(msg.url ? String(msg.url) : "", msg.query ? String(msg.query) : "", msg.cap, msg.tabId, msg.refMode);
    case "tab.act":
      return tabAct(msg.url ? String(msg.url) : "", String(msg.intent || ""), msg.params || {}, msg.tabId, msg.refMode);
    case "tab.batch":
      return tabBatch(msg.url ? String(msg.url) : "", Array.isArray(msg.steps) ? msg.steps : [], msg.tabId, msg.refMode);
    case "cookies.export":
      return cookiesExport(Array.isArray(msg.domains) ? msg.domains : null);
    default:
      throw new Error("неизвестный интент: " + msg.type);
  }
}

/**
 * Прочитать ЦЕЛЕВУЮ (tabId из open / по хосту url) вкладку — в ТВОЕЙ залогиненной сессии.
 * query — ключевые слова: каждый фрейм фильтрует свой текст (см. readPageInPage). Читаем ВСЕ фреймы
 * (allFrames) — контент часто живёт в iframe (встроенный плеер/форма/доки), раньше read его не видел
 * вовсе; дочерние фреймы идут маркированными блоками после top-фрейма, в общий кап 8K.
 */
async function tabRead(url, tabId, query) {
  const tab = await findTargetTab(url, tabId);
  if (!tab || tab.id == null) throw noTabError(url);
  if (tab.status !== "complete") await waitForTabReady(tab.id);
  const args = [String(query || "")];
  let frames;
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: readPageInPage, args });
  } catch {
    // allFrames падает целиком на экзотике (PDF-viewer, недоступный фрейм) → честный откат на top-фрейм
    frames = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageInPage, args });
  }
  // SSRF-гард (ревью-security): дочерний фрейм на приватный/loopback хост (роутер/intranet/метаданные)
  // НЕ включаем — allFrames на привилегии расширения обошёл бы SOP и слил его содержимое модели. Top-фрейм
  // не режем: его URL прошёл серверный browserUrlBlocked при open/read.
  const results = (frames || []).filter((f) => f && f.result && ((f.frameId || 0) === 0 || !isPrivateHost(f.result.url)));
  const topFrame = results.find((f) => (f.frameId || 0) === 0);
  const main = (topFrame && topFrame.result) || { title: tab.title || "", url: tab.url || "", text: "", headings: [] };
  const hasQuery = String(query || "").trim().length > 0;
  const CAP = 8000;
  const PER_FRAME_CAP = 3000; // один фрейм не съедает весь бюджет (страница с десятками ad/consent-iframe)
  // Дочерние фреймы: при query СМАТЧИВШИЕ (filtered) идут ПЕРВЫМИ (иначе полный raw-дамп несматчившего
  // top/фрейма вытеснял бы найденный блок из капа — ревью). content <40 симв (служебные) не тащим.
  const children = results.filter((f) => (f.frameId || 0) !== 0 && f.result && String(f.result.text || "").trim().length >= 40);
  const rank = (f) => (hasQuery && f.result.filtered ? 0 : 1);
  children.sort((a, b) => rank(a) - rank(b));
  // filtered наружу = ЛЮБОЙ включённый фрейм сматчил query (top ИЛИ дочерний) — не только top (ревью).
  const childMatched = children.some((f) => f.result.filtered);
  const anyFiltered = Boolean(main.filtered) || childMatched;
  // При query, если top НЕ сматчил, а сматчил ДОЧЕРНИЙ фрейм — top raw-дамп режем, чтобы освободить место
  // найденному блоку. Если не сматчил НИКТО — оставляем полный top (общее чтение, дамп не теряем).
  let text = hasQuery && !main.filtered && childMatched ? String(main.text || "").slice(0, 2000) : String(main.text || "");
  for (const f of children) {
    if (text.length >= CAP) break;
    const r = f.result;
    const t = String(r.text || "").trim().slice(0, PER_FRAME_CAP);
    const head = "\n\n--- iframe " + (r.url || "") + " ---\n";
    text += head + t.slice(0, Math.max(0, CAP - text.length - head.length));
  }
  // fix 2026-07-15: медиа-состояние из ЛЮБОГО фрейма с плеером (top ИЛИ встроенный iframe-плеер). Между
  // фреймами выбираем самый КРУПНЫЙ видимый плеер по площади (ревью: НЕ «первый играющий» — публичный
  // ad-iframe с играющим видео иначе бил бы паузный основной контент). Агент читает время из DOM (currentTime),
  // а не из видимого таймера, который сайты прячут при простое мыши.
  const medias = results.map((f) => f && f.result && f.result.media).filter(Boolean);
  const media = medias.length ? medias.slice().sort((a, b) => (b.area || 0) - (a.area || 0))[0] : null;
  return {
    title: main.title || "",
    url: main.url || tab.url || "",
    text: text.slice(0, CAP),
    headings: Array.isArray(main.headings) ? main.headings : [],
    filtered: anyFiltered,
    ...(media ? { media } : {}),
  };
}

/**
 * ГЛАЗА В DOM: снимок интерактивных элементов вкладки (кнопки/ссылки/инпуты) с УСТОЙЧИВЫМИ селекторами,
 * текстом, aria-label, ролью, состоянием. Чтобы модель САМА видела реальную страницу и прицельно
 * действовала browser_act{selector}, а не угадывала. Универсально (любой сайт), без хардкода под сервис.
 */
async function tabInspect(url, query, cap, tabId, refMode) {
  const tab = await findTargetTab(url, tabId);
  if (!tab || tab.id == null) throw noTabError(url);
  if (tab.status !== "complete") await waitForTabReady(tab.id);
  const capN = Number(cap) || 80;
  const args = [query || "", capN, Boolean(refMode)];
  // ВСЕ фреймы: интерактив часто живёт в iframe (embed-плеер/форма/оплата) — раньше inspect был слеп к ним.
  let frames;
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: inspectPageInPage, args });
  } catch {
    frames = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectPageInPage, args });
  }
  // SSRF-гард (ревью-security): дочерний фрейм на приватный/loopback хост не осматриваем (см. tabRead).
  const results = (frames || []).filter((f) => f && f.result && ((f.frameId || 0) === 0 || !isPrivateHost(f.result.url)));
  results.sort((a, b) => (a.frameId || 0) - (b.frameId || 0)); // top-фрейм первым
  const top = results.find((f) => (f.frameId || 0) === 0);
  const elements = [];
  const frameList = [];
  let truncated = false;
  for (const f of results) {
    const els = (f.result && f.result.elements) || [];
    if (f.result && f.result.truncated) truncated = true;
    if (!els.length) continue;
    if ((f.frameId || 0) !== 0) frameList.push({ frameId: f.frameId, url: (f.result && f.result.url) || "", count: els.length });
    for (const el of els) {
      if (elements.length >= capN) { truncated = true; break; }
      // Элемент из iframe несёт frameId — модель передаёт его в browser_act{params.frameId} для точного
      // попадания. ref frame-scoped: дочерний фрейм → префикс f<frameId> (top остаётся e<gen>_<n>); act
      // парсит обратно, чтобы адресовать реестр НУЖНОГО фрейма (у каждого фрейма свой __jarvisRefs/gen).
      const fid = f.frameId || 0;
      if (fid !== 0) {
        if (el.ref) el.ref = "f" + fid + el.ref;
        el.frameId = fid;
      }
      elements.push(el);
    }
    if (elements.length >= capN) break;
  }
  elements.forEach((el, i) => { el.idx = i; }); // сквозная нумерация после слияния фреймов
  return {
    url: (top && top.result && top.result.url) || tab.url || "",
    title: (top && top.result && top.result.title) || tab.title || "",
    count: elements.length,
    truncated,
    frames: frameList,
    elements,
  };
}

/**
 * Исполняется ВНУТРИ страницы (self-contained — инжектится через executeScript, НЕ может ссылаться на
 * модули; все хелперы инлайн). Собирает интерактив + устойчивый селектор + accessibleName + СОСТОЯНИЕ
 * (checked/expanded/pressed/selected/value/[ПУСТО]). refMode → дополнительно минтит ref-реестр в
 * globalThis.__jarvisRefs (ISOLATED-world: переживает executeScript и LLM-раунды, умирает на навигации →
 * ref честно протухает сам). ref-адресация устойчивее хрупкого nth-of-type селектора к ре-рендеру SPA.
 */
function inspectPageInPage(query, cap, refMode) {
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
  // Стабильный ЯКОРЬ узла: id → data-* (расширенный список test-атрибутов) → aria-label. БЕЗ хеш-классов.
  const anchorFor = (node) => {
    if (stableId(node.getAttribute("id"))) return "#" + esc(node.getAttribute("id"));
    for (const a of ["data-test-id", "data-testid", "data-marker", "data-qa", "data-test", "data-cy", "data-e2e", "data-automation-id", "data-automationid"]) {
      const v = node.getAttribute(a);
      if (v) return node.tagName.toLowerCase() + "[" + a + '="' + esc(v) + '"]';
    }
    const al = node.getAttribute("aria-label");
    if (al) return node.tagName.toLowerCase() + '[aria-label="' + esc(al) + '"]';
    return null;
  };
  // Устойчивый селектор: якорь узла → name/placeholder → nth-of-type цепочка, АНКОРЁННАЯ к ближайшему
  // стабильному предку (фикс мёртвого break: раньше seg никогда не нёс #/атрибут → цепочка не якорилась
  // и ломалась на ре-рендере). refMode делает основной адресацией ref, селектор — fallback.
  const selFor = (node) => {
    const self = anchorFor(node);
    if (self) return self;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) {
      const nm = node.getAttribute("name");
      if (nm) return node.tagName.toLowerCase() + '[name="' + esc(nm) + '"]';
      const ph = node.getAttribute("placeholder");
      if (ph) return node.tagName.toLowerCase() + '[placeholder="' + esc(ph) + '"]';
    }
    const parts = [];
    let n = node;
    let d = 0;
    while (n && n.nodeType === 1 && d < 5) {
      // Якорим цепочку к БЛИЖАЙШЕМУ стабильному предку и обрываем — короткий устойчивый путь.
      if (n !== node) {
        const a = anchorFor(n);
        if (a) { parts.unshift(a); break; }
      }
      const p = n.parentElement;
      let seg = n.tagName.toLowerCase();
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === n.tagName);
        seg += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
      }
      parts.unshift(seg);
      n = p;
      d += 1;
    }
    return parts.join(" > ");
  };
  // accessibleName — прагматичный subset accname-1.2 (aria-labelledby → aria-label → <label> → текст →
  // placeholder/title). Для выбора элемента моделью; при refMode адресация всё равно по идентичности ref.
  const axName = (el) => {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => { try { const nd = document.getElementById(id); return nd ? (nd.innerText || nd.getAttribute("aria-label") || "").trim() : ""; } catch { return ""; } }).filter(Boolean).join(" ").trim();
      if (t) return t.slice(0, 80);
    }
    const al = el.getAttribute("aria-label");
    if (al && al.trim()) return al.trim().slice(0, 80);
    if (el.id) { try { const lab = document.querySelector('label[for="' + esc(el.id) + '"]'); if (lab && (lab.innerText || "").trim()) return lab.innerText.trim().replace(/\s+/g, " ").slice(0, 80); } catch { /* ignore */ } }
    const lab2 = el.closest && el.closest("label");
    if (lab2 && (lab2.innerText || "").trim()) return lab2.innerText.trim().replace(/\s+/g, " ").slice(0, 80);
    const txt = (el.innerText || el.value || "").replace(/\s+/g, " ").trim();
    if (txt) return txt.slice(0, 80);
    return ((el.getAttribute("placeholder") || el.getAttribute("title") || "").trim()).slice(0, 80);
  };
  // СОСТОЯНИЕ элемента: value/[ПУСТО] у полей + checked/selected/expanded/pressed/disabled. Раньше снимок
  // видел только disabled → вопрос «тумблер включён?» требовал screen_capture. Теперь состояние в снимке.
  const stateOf = (el) => {
    const st = {};
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (/^(INPUT|TEXTAREA)$/.test(tag) || el.isContentEditable) {
      const v = el.isContentEditable ? (el.innerText || "") : (el.value || "");
      st.value = type === "password" ? (v ? "•••" : "") : v.slice(0, 60);
      if (!v) st.empty = true;
    }
    if (type === "checkbox" || type === "radio") st.checked = Boolean(el.checked);
    const ac = el.getAttribute("aria-checked"); if (ac != null) st.checked = ac === "true" ? true : ac === "false" ? false : ac;
    const asel = el.getAttribute("aria-selected"); if (asel != null) st.selected = asel === "true";
    const aexp = el.getAttribute("aria-expanded"); if (aexp != null) st.expanded = aexp === "true";
    const apr = el.getAttribute("aria-pressed"); if (apr != null) st.pressed = apr === "true";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") st.disabled = true;
    return st;
  };
  // SHADOW DOM: querySelectorAll не заглядывает в открытые shadow root'ы (веб-компоненты) — обходим
  // дерево рекурсивно, иначе половина интерактива современных сайтов невидима «глазам».
  const collectDeep = () => {
    const found = [];
    const walk = (root) => {
      let list = [];
      try { list = root.querySelectorAll(SEL); } catch { /* битый селектор невозможен, страховка */ }
      for (const el of list) found.push(el);
      let all = [];
      try { all = root.querySelectorAll("*"); } catch { /* ignore */ }
      for (const h of all) if (h.shadowRoot) walk(h.shadowRoot);
    };
    walk(document);
    return found;
  };
  // Селектор СКВОЗЬ shadow-границы: «host >>> inner» (act-резолвер понимает эту форму). Элемент вне
  // shadow → обычный селектор (одно звено).
  const selForDeep = (node) => {
    const chain = [];
    let cur = node;
    for (let depth = 0; cur && depth < 5; depth += 1) {
      chain.unshift(selFor(cur));
      const root = cur.getRootNode && cur.getRootNode();
      if (root && root.host) cur = root.host;
      else break;
    }
    return chain.join(" >>> ");
  };
  // ref-реестр в ISOLATED-world (только refMode): новый gen на каждый снимок, старая map отбрасывается
  // (detached-узлы не копятся). Инкремент per-frame (allFrames инжектит функцию в каждый фрейм отдельно) —
  // SW добавит префикс f<frameId>; ref несёт СВОЙ gen → act сам ловит устаревший снимок (ref_stale).
  let REG = null;
  let gen = 0;
  if (refMode) {
    REG = globalThis.__jarvisRefs || (globalThis.__jarvisRefs = { gen: 0, map: null });
    REG.gen += 1;
    gen = REG.gen;
    REG.map = new Map();
  }
  const nodes = collectDeep();
  const seen = new Set();
  const out = [];
  let truncated = false;
  for (const el of nodes) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!visible(el)) continue;
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const name = axName(el);
    const aria = el.getAttribute("aria-label") || "";
    const text = (el.innerText || el.value || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (q && !(lc(name) + " " + lc(text) + " " + lc(aria) + " " + lc(role)).includes(q)) continue;
    if (out.length >= cap) {
      truncated = true;
      break;
    }
    const state = stateOf(el);
    if (refMode) {
      // Компактная форма: ref (адресация по идентичности) + role + name + state + селектор-fallback.
      const ref = "e" + gen + "_" + out.length;
      REG.map.set(ref, el);
      out.push({ idx: out.length, ref, role, name: name || null, state, selector: selForDeep(el), href: el.tagName === "A" ? el.getAttribute("href") : null });
    } else {
      // Legacy-форма (refMode off) сохранена бит-в-бит + добавлено state (аддитивно, поведение не меняет).
      out.push({
        idx: out.length,
        tag: el.tagName.toLowerCase(),
        role,
        text,
        aria: aria.slice(0, 80) || null,
        selector: selForDeep(el),
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
        state,
        href: el.tagName === "A" ? el.getAttribute("href") : null,
      });
    }
  }
  return { url: location.href, title: document.title || "", count: out.length, truncated, gen, elements: out };
}

/**
 * SELF-HEAL наблюдаемой вкладки (эпизод «перекрыл вкладку — Джарвис сдался» 2026-07-24). Chrome
 * (Memory Saver) ВЫГРУЖАЕТ фоновую вкладку, когда её перекрыли другой: DOM пуст, чтение отдаёт пустой
 * textContent, а durable-наблюдение вечно видит «условие не выполнено». Здесь — ремонт БЕЗ кражи
 * фокуса: выгруженную вкладку перезагружаем (chrome.tabs.reload не активирует её), закрытую —
 * переоткрываем ФОНОВОЙ (active:false). Включается ТОЛЬКО params.recover=true, который сервер ставит
 * лишь для watch-предиката/wait_for — обычные act/read вкладки пользователя не трогают.
 */
/**
 * Анти-флаппинг ремонта: когда ПОСЛЕДНИЙ раз чинили вкладку (ключ — tabId||url). Окно 60с: достаточно
 * редко, чтобы не дёргать сайт и не мигать пользователю, но КОРОЧЕ бюджета dead-watch (10 провалов
 * подряд × период тика ≥10с ⇒ ≥100с) — иначе повторное выгружение вкладки приостанавливало бы
 * ИСПРАВИМОЕ наблюдение раньше, чем ремонт вообще получил бы право сработать (ревью р2 #12).
 */
const reviveAt = new Map();
const REVIVE_COOLDOWN_MS = 60_000;

/**
 * Только http(s) — предикат наблюдения НЕ должен становиться каналом навигации в file:/chrome:/data:
 * (ревью). Голый хост («shop.ru/order/1» — LLM сплошь даёт именно его, см. hostOf) нормализуем в https,
 * иначе переоткрыть страницу было бы нечем, а гард дал бы ложное «адрес небезопасен».
 */
function safeHttpUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : "https://" + raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

async function reviveTab(tab, url, key) {
  const k = String(key || (tab && tab.id) || url || "");
  const last = reviveAt.get(k) || 0;
  // Ремонт не чаще раза в 5 минут на цель: наблюдение тикает каждые 5-30с, и без кулдауна одна упрямая
  // страница означала бы reload каждые несколько секунд (нагрузка на сайт + мигание у пользователя).
  if (Date.now() - last < REVIVE_COOLDOWN_MS) return { tab, recovered: null, throttled: true };
  reviveAt.set(k, Date.now());
  if (!tab || tab.id == null) {
    const safe = safeHttpUrl(url);
    if (!safe) return { tab: null, recovered: null };
    // Сначала ИЩЕМ уже открытую вкладку с этим адресом — иначе каждый тик плодил бы новую (ревью #9).
    try {
      const existing = await chrome.tabs.query({ url: safe.split("#")[0] });
      if (existing && existing.length && existing[0].id != null) return { tab: existing[0], recovered: "found" };
    } catch { /* query по url может отвергнуть шаблон — падаем на создание */ }
    const fresh = await chrome.tabs.create({ url: safe, active: false });
    await waitTabComplete(fresh.id);
    let t = fresh;
    try { t = await chrome.tabs.get(fresh.id); } catch { /* оставим исходный снимок */ }
    return { tab: t, recovered: "reopened" };
  }
  await chrome.tabs.reload(tab.id, { bypassCache: false });
  await waitTabComplete(tab.id);
  let t = tab;
  try { t = await chrome.tabs.get(tab.id); } catch { /* закрылась во время reload */ }
  return { tab: t, recovered: "reloaded" };
}

/**
 * Чтение вернуло ПУСТУЮ страницу — признак выгруженной/неотрендеренной вкладки. ⚠️ Только для ШИРОКОГО
 * таргета (сервер ставит recoverIfBlank лишь для body/html/main/#root — у живой страницы там пусто не
 * бывает). Легитимно пустой УЗКИЙ элемент («статус ещё не проставлен») и «элемента ещё нет» (not_found)
 * поводом к ремонту НЕ считаются — иначе перезагружали бы живую вкладку пользователя каждый тик,
 * стирая его ввод (ревью 2026-07-24, CRITICAL). `len` — полная длина текста ДО обрезки.
 */
function looksBlankRead(res) {
  if (!res || res.ok !== true) return false;
  if (typeof res.blank === "boolean") return res.blank; // blank считается по TRIM (пробелы = пусто)
  return typeof res.value === "string" && res.value.trim() === "";
}

/** Выполнить действие В ЦЕЛЕВОЙ вкладке (play/pause/next/click/type/scroll) через chrome.scripting. */
async function tabAct(url, intent, params, tabId, refMode) {
  const P = params || {};
  // Self-heal (см. reviveTab) — ТОЛЬКО текстовое чтение наблюдения и только по явному recover.
  // readMedia сознательно НЕ чиним: reload сбросил бы позицию воспроизведения (а условие «видео дошло
  // до N секунд» именно её и ждёт) — лечение оказалось бы хуже болезни.
  const mayRevive = P.recover === true && intent === "getValue";
  // Пустое чтение чиним ТОЛЬКО когда сервер подтвердил ШИРОКИЙ таргет (body/html/main/#root): у живой
  // страницы там пусто не бывает. Узкий селектор пустым бывает законно — его reload'ить нельзя (ревью).
  const mayReviveBlank = mayRevive && P.recoverIfBlank === true;
  let tab = await findTargetTab(url, tabId);
  let recovered = null;
  // ⚠️ У findTargetTab есть фолбэк «активная вкладка» (нет живого tabId и нет хоста) — для НАБЛЮДЕНИЯ он
  // недопустим: читать/перезагружать вкладку, которую пользователь сейчас смотрит, значит и врать
  // «Сработало» по чужой странице, и портить его работу (ревью, CRITICAL). Поэтому в recover-режиме
  // ТРЕБУЕМ доказанную идентичность цели: тот же tabId ЛИБО тот же хост. Не доказана → честная ошибка
  // «нет вкладки» (наблюдение дойдёт до dead-watch и доложит). Обычные browser_act/read этим не задеты.
  if (mayRevive && tab) {
    const wantHost = hostOf(url);
    const sameTab = tabId != null && tab.id === tabId;
    const sameSite = Boolean(wantHost) && hostOf(tab.url || "") === wantHost;
    if (!sameTab && !sameSite) tab = null;
  }
  if (mayRevive && (!tab || tab.id == null || tab.discarded === true)) {
    // Вкладку закрыли (нет tab) ИЛИ Chrome выгрузил её из памяти (discarded) → чиним ДО чтения.
    const rev = await reviveTab(tab, url, tabId != null ? "t" + tabId : url);
    if (rev.tab) { tab = rev.tab; recovered = rev.recovered; }
  }
  if (!tab || tab.id == null) throw noTabError(url);
  if (tab.status !== "complete") await waitForTabReady(tab.id);
  // Явный frameId из browser_inspect (элемент в iframe) — целимся точно в тот фрейм.
  const fidRaw = Number(P.frameId);
  let explicitFrame = Number.isFinite(fidRaw) && fidRaw > 0 ? fidRaw : undefined;
  // REF-АДРЕСАЦИЯ (refMode): P.ref из последнего снимка — адресуем элемент по ИДЕНТИЧНОСТИ (устойчиво к
  // ре-рендеру SPA), а не по хрупкому селектору/тексту. Формат f<frameId>e<gen>_<n> (top-фрейм без f-префикса).
  let localRef = null;
  if (refMode && P.ref !== undefined && P.ref !== null && String(P.ref).trim()) {
    const m = /^(?:f(\d+))?(e\d+_\d+)$/.exec(String(P.ref).trim());
    if (!m) throw new Error("tab.act " + intent + ": некорректный ref «" + P.ref + "» — сделай browser_inspect заново");
    // Ревью AX-Ref #5: при наличии ref ФРЕЙМ берём ИСКЛЮЧИТЕЛЬНО из ref (источник истины адресации). Иначе
    // стейл P.frameId + top-ref (m[1] undefined) резолвил бы ref в реестре ЧУЖОГО фрейма (gen не уникален
    // между фреймами → сверка проходит на другом узле → клик не туда с ложным успехом). Сбрасываем P.frameId.
    explicitFrame = m[1] !== undefined ? Number(m[1]) : undefined;
    localRef = m[2];
  }
  // ⚠️ urlBefore перечитываем ПОСЛЕ waitForTabReady (снапшот findTargetTab мог быть в статусе loading с
  //  about:blank/старым URL → протухший baseline давал ложный navigated-успех, ревью critical). Свежий url.
  let urlBefore = tab.url || "";
  try { const t0 = await chrome.tabs.get(tab.id); if (t0 && t0.url) urlBefore = t0.url; } catch { /* оставим снапшот */ }
  // Навигация top-фрейма как ИСХОД действия правдоподобна ТОЛЬКО для клика (ссылка/сабмит уводят страницу).
  // Для type/enter/seek/play/pause «твой ввод вызвал переход» почти всегда ложь → там смерть контекста = провал.
  const navPlausible = intent === "click" || intent === "shake";
  /**
   * Исполнить page-функцию в top-фрейме/конкретном фрейме. Смерть контекста от навигации (executeScript
   * падает «frame was removed»/«No frame») обрабатывается ЧЕСТНО:
   *  • frameId задан → ошибка относится к ФРЕЙМУ, не вкладке: НЕ выдаём вкладочную навигацию за успех (ревью
   *    #4 — иначе клик в фоновом iframe рапортовался бы вкладочным navigated). Честный провал «фрейм исчез».
   *  • top-фрейм + клик + вкладка реально ушла (url сменился/грузится) → {ok:true, navigated, uncertain:true}
   *    — переход ВЕРОЯТЕН, но исход клика НЕ подтверждён (uncertain → сервер НЕ снимает verify-долг, ревью #1/#8).
   *  • иначе (не клик, или вкладка НЕ ушла) → исходная ошибка пробрасывается (провал, модель сверит/повторит).
   */
  const runInPage = async (world, func, args, frameId) => {
    const inj = { target: frameId !== undefined ? { tabId: tab.id, frameIds: [frameId] } : { tabId: tab.id }, func, args };
    if (world) inj.world = world;
    try {
      const [res] = await chrome.scripting.executeScript(inj);
      return (res && res.result) || { ok: false, error: "executeScript без результата" };
    } catch (e) {
      const msg = String((e && e.message) || e);
      const contextDied = /(removed|destroyed|invalidated|closed|No frame)/i.test(msg);
      if (contextDied && frameId !== undefined) {
        // Целевой ФРЕЙМ исчез (перезагрузился/клик увёл встроенный iframe). НЕ выдаём за вкладочную
        // навигацию-успех (ревью #4) и НЕ роняем криптичную ошибку Chrome в canvas-хатч. Честный провал +
        // прямой запрет слепого повтора (иначе тот же selector сработал бы в перезагруженном фрейме дважды).
        return { ok: false, code: "frame_gone", error: "целевой фрейм " + frameId + " исчез (страница/встроенный фрейм перезагрузились — возможно, действие уже сработало). Сделай свежий browser_inspect и сверься ПРЕЖДЕ чем повторять — не кликай вслепую." };
      }
      if (contextDied && navPlausible) {
        await sleep(400);
        try {
          const t = await chrome.tabs.get(tab.id);
          if (t && (t.status === "loading" || (t.url || "") !== urlBefore)) {
            // uncertain: клик, ВЕРОЯТНО, увёл страницу, но подтвердить его исход мы не смогли — не ложный успех.
            return { ok: true, navigated: t.url || t.pendingUrl || true, uncertain: true, note: "страница перешла во время действия — исход не подтверждён" };
          }
        } catch { /* вкладка закрыта — ниже исходная ошибка */ }
      }
      throw e;
    }
  };
  // Гейт probe: щупаем фреймы ТОЛЬКО когда цель НЕ НАЙДЕНА в top (code:"not_found"). При «клик прошёл, но
  // эффекта нет» (code:"no_effect", expectChange) — действие УЖЕ отработало в top, повтор в iframe = двойной
  // side-effect (ревью #C). Ошибка без code (исключение/навигация) — тоже НЕ щупаем.
  const shouldProbe = (r) => Boolean(r) && r.ok !== true && r.code === "not_found" && explicitFrame === undefined;
  const ptext = String(P.text || "");
  const isShake = /встрях|стряхн|обнов/.test(ptext.toLowerCase());
  // REF-ПУТЬ: адресуем по идентичности из реестра снимка. click-подобные (click/shake/play/pause/next/prev) —
  // через nonce-мост в MAIN (React-onClick минует Swiper-гейт, точнее синтетики); type/seek/scroll/enter/submit —
  // в ISOLATED (там же реестр) с нативным readback (value) как STRONG-сигналом. ref_stale → честный провал,
  // НЕ слепой хит по устаревшему узлу (устойчивость к ре-рендеру = вся суть механизма).
  if (localRef) {
    const clickLike = ["click", "shake", "play", "pause", "next", "prev"].includes(intent) || isShake;
    if (clickLike) {
      const nonce = "jn" + Date.now() + "_" + Math.floor(Math.random() * 1e9);
      const stamp = await runInPage(null, stampRefIsolated, [localRef, nonce], explicitFrame);
      if (!stamp.ok) throw new Error("tab.act " + intent + ": " + (stamp.error || "ref не разрешён"));
      const rc = await runInPage("MAIN", robustClickMain, [{ nonce, expectChange: intent === "shake" || isShake }], explicitFrame);
      if (!rc.ok) throw new Error("tab.act " + intent + ": " + (rc.error || "не вышло"));
      // play/pause: подтвердить исход media ground-truth. Ревью AX-Ref #4: rc.playing взводим ТОЛЬКО когда
      // состояние СОВПАЛО с намерением (play→playing, pause→paused); не совпало (autoplay-гейт / клик по не-той
      // кнопке) → честный провал, как mediaControlMain (иначе observed снял бы долг на «не заигравшем» play).
      // Нет медиаэлемента (MSE-плеер типа Я.Музыки → st.playing undefined) — rc.playing НЕ ставим: сервер долг
      // по playing не снимет, модель сверит aria-label сама (не врём «играет» без ground-truth).
      if (intent === "play" || intent === "pause") {
        let st = null;
        try { st = await runInPage(null, readMediaStateIsolated, [], explicitFrame); } catch { /* ignore */ }
        if (st && st.playing !== undefined) {
          const wanted = intent === "play";
          if (st.playing !== wanted) {
            throw new Error(
              "tab.act " + intent + ": " + (wanted
                ? "клик по play прошёл, но воспроизведение НЕ началось (autoplay браузера блокирует программный старт) — нужен живой клик, не ври «играет»"
                : "клик по pause прошёл, но плеер всё ещё играет — вероятно, кнопка не та"),
            );
          }
          rc.playing = st.playing;
        }
      }
      return rc;
    }
    const rr = await runInPage(null, actByRefIsolated, [localRef, intent, P], explicitFrame);
    if (!rr.ok) throw new Error("tab.act " + intent + ": " + (rr.error || "не вышло"));
    return rr;
  }
  // КЛИК (и встряхивание) — через MAIN-world РОБАСТ-клик: React-onClick/Enter минуют Swiper-гейт,
  // который в capture-фазе глушит синтетику (корень «встряхнуть не срабатывает», подтверждено). Остальные
  // интенты (play/pause/next/scroll/type/back/forward) — в ISOLATED через pageActInPage, там это работает.
  if (intent === "click" || intent === "shake" || isShake) {
    const clickParams = { ...P, refMode: Boolean(refMode) };
    if (intent === "shake" || isShake) {
      clickParams.text = clickParams.text || "встряхнуть";
      clickParams.expectChange = true; // встряхивание подтверждаем по реальной смене контента (честность)
    }
    // НЕ активируем вкладку, мышь не трогаем; world:MAIN — чтобы видеть React-props страницы (CSP-safe: функция статична).
    let rc = await runInPage("MAIN", robustClickMain, [clickParams], explicitFrame);
    // Не найден в top-фрейме и фрейм не задан → элемент может жить в iframe: ПРОЩУПАТЬ фреймы (probe
    // только ИЩЕТ с тем же скорингом, что и клик; действие затем бьётся точно в лучший найденный фрейм).
    if (shouldProbe(rc)) {
      const hit = await probeFrames(tab.id, { selector: clickParams.selector || "", text: clickParams.text || "" });
      if (hit) {
        rc = await runInPage("MAIN", robustClickMain, [clickParams], hit.frameId);
        if (rc.ok) { rc.frame = hit.frameId; rc.frameUrl = hit.url; }
      }
    }
    if (!rc.ok) throw new Error("tab.act click: " + (rc.error || "не вышло"));
    return rc;
  }
  // PLAY/PAUSE — точечно В ЭТОЙ вкладке через MAIN-world React-onClick по кнопке плеера. НЕ через
  // системную медиа-клавишу (она глобальная — снимала с паузы YouTube/чужой плеер, реальный баг).
  if (intent === "play" || intent === "pause") {
    let rm = await runInPage("MAIN", mediaControlMain, [intent], explicitFrame);
    // Плеер часто embed'ится в iframe (YouTube-встройка) — top без медиа → ищем фрейм с РЕАЛЬНЫМ медиа
    // (видимое+крупное, не muted-autoplay рекламный трекер — ревью #2/#B).
    if (shouldProbe(rm)) {
      const hit = await probeFrames(tab.id, { media: true });
      if (hit) {
        rm = await runInPage("MAIN", mediaControlMain, [intent], hit.frameId);
        if (rm.ok) { rm.frame = hit.frameId; rm.frameUrl = hit.url; }
      }
    }
    if (!rm.ok) throw new Error("tab.act " + intent + ": " + (rm.error || "не вышло"));
    return rm;
  }
  // АВТОЛИСТАНИЕ ЛЕНТЫ КОРОТКИХ ВИДЕО (Shorts/Reels, 2026-07-25 по просьбе владельца): ставим в СТРАНИЦУ
  // persistent-поллер, который сам переключает на следующий ролик, когда текущий доиграл. Без него задача
  // «листай шортсы по окончании» требовала бы LLM-раунда на КАЖДЫЙ ролик (дорого и медленно) — а так это
  // $0 и работает, пока владелец смотрит. Живёт в ISOLATED-world (как ref-реестр) → переживает SPA-переходы
  // между роликами; полная перезагрузка страницы его снимает (честно сообщаем это в описании инструмента).
  if (intent === "feed_auto") {
    const rr = await runInPage(
      null,
      feedAutoInPage,
      [{ action: String(P.action || "start"), maxCount: Number(P.maxCount) || 0, maxMinutes: Number(P.maxMinutes) || 0 }],
      explicitFrame,
    );
    if (!rr || rr.ok !== true) throw new Error("tab.act feed_auto: " + ((rr && rr.error) || "не вышло"));
    return rr;
  }
  const Pm = { ...P, refMode: Boolean(refMode) }; // refMode → pageActInPage гейтит Яндекс-навигацию хардкода
  let r = await runInPage(null, pageActInPage, [intent, Pm], explicitFrame);
  // Self-heal ПОСЛЕ чтения: страница ответила, но ВЕСЬ её текст ПУСТ (Chrome выгрузил содержимое
  // перекрытой вкладки — discarded ставится не всегда) → перезагружаем и перечитываем. Иначе durable-
  // наблюдение молча считало бы «условие не выполнено» (живой эпизод: 35 минут тишины про доставку).
  // ⚠️ Только широкий таргет (mayReviveBlank) и только НЕ активная вкладка: перезагрузка страницы,
  // которую пользователь сейчас читает/заполняет, — это порча его работы, а не помощь.
  let reviveThrottled = false;
  if (mayReviveBlank && !recovered && looksBlankRead(r) && tab.active !== true) {
    const rev = await reviveTab(tab, url || tab.url || "", tabId != null ? "t" + tabId : url);
    reviveThrottled = rev.throttled === true;
    if (rev.tab) {
      tab = rev.tab;
      recovered = rev.recovered;
      if (recovered) r = await runInPage(null, pageActInPage, [intent, Pm], explicitFrame);
    }
  }
  if (shouldProbe(r)) {
    // type: поле может жить в iframe (embed-форма); seek: медиа в embed-плеере. Прочие интенты не щупаем.
    const probeArg =
      intent === "type" ? { input: true, selector: P.selector || "" } : intent === "seek" ? { media: true } : null;
    if (probeArg) {
      const hit = await probeFrames(tab.id, probeArg);
      if (hit) {
        r = await runInPage(null, pageActInPage, [intent, Pm], hit.frameId);
        if (r.ok) { r.frame = hit.frameId; r.frameUrl = hit.url; }
      }
    }
  }
  if (!r.ok) throw new Error("tab.act " + intent + ": " + (r.error || "не вышло"));
  // Актуальные координаты вкладки (могла быть переоткрыта → НОВЫЙ tabId) — сервер обновит ими предикат
  // наблюдения, иначе следующий тик снова искал бы мёртвый tabId. tabUrl нужен для будущих переоткрытий.
  if (mayRevive) {
    r.tabId = tab.id;
    if (tab.url) r.tabUrl = tab.url;
    if (recovered) r.recovered = recovered;
    // Ремонт был нужен, но упёрся в кулдаун — сервер посчитает такую слепоту ВРЕМЕННОЙ и не станет
    // приостанавливать наблюдение раньше, чем починка вообще получила право сработать (ревью р2 #12).
    if (reviveThrottled) r.reviveThrottled = true;
  }
  return r;
}

/**
 * АВТОЛИСТАНИЕ ЛЕНТЫ КОРОТКИХ ВИДЕО (YouTube Shorts и подобные) — инжектируется в СТРАНИЦУ (ISOLATED
 * world, self-contained: executeScript сериализует функцию БЕЗ замыканий — никаких внешних хелперов).
 *
 * Зачем: «листай шортсы, когда доигрывают» через LLM-петлю стоило бы раунда на каждый ролик (секунды и
 * центы за штуку) и упиралось бы в потолок задачи. Здесь — обычный поллер в странице: $0, реагирует за
 * доли секунды, живёт, пока владелец смотрит.
 *
 * Как ловим «ролик кончился»: Shorts ЗАЦИКЛЕНЫ (loop) — события `ended` обычно НЕ будет. Поэтому
 * детектируем ЗАВЁРНУТЫЙ круг: время было у самого конца, а стало около нуля у ТОГО ЖЕ ролика. Плюс
 * честный `ended` (если loop выключен). Смена ролика узнаётся по currentSrc — счётчик не путается.
 *
 * Рельсы (анти-runaway, чтобы не листать вечно): лимит роликов и лимит минут; по исчерпании поллер сам
 * останавливается с внятной причиной, которую видно в status. Повторный start перезапускает (не плодит
 * второй поллер). Полная перезагрузка страницы снимает автолистание — это ЧЕСТНО сообщается в схеме.
 */
function feedAutoInPage(cfg) {
  const KEY = "__jarvisFeedAuto";
  const state = globalThis[KEY];
  const action = (cfg && cfg.action) || "start";

  if (action === "stop") {
    const advanced = state ? state.advanced : 0;
    if (state && state.timer) clearInterval(state.timer);
    globalThis[KEY] = undefined;
    return { ok: true, running: false, advanced, note: state ? "автолистание остановлено" : "автолистание и не было запущено" };
  }
  if (action === "status") {
    // Три РАЗЛИЧИМЫХ исхода (ревью: раньше самоостановка стирала состояние, и «остановилось по лимиту»
    // было неотличимо от «не запускалось» — модель не могла честно доложить владельцу, что случилось).
    if (!state) return { ok: true, running: false, advanced: 0, note: "автолистание не запускалось" };
    if (!state.timer) {
      return { ok: true, running: false, advanced: state.advanced, stoppedReason: state.stoppedReason || "остановлено", note: "автолистание остановлено" };
    }
    return { ok: true, running: true, advanced: state.advanced, stoppedReason: null };
  }

  // ── start ──────────────────────────────────────────────────────────────────────────────────────

  const pickVideo = () => {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const st = getComputedStyle(v);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) continue;
      const area = r.width * r.height;
      if (r.width < 120 || r.height < 120) continue; // 1×1-трекеры и превью-миниатюры мимо
      if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
  };
  const nextButton = () => {
    const sels = [
      "#navigation-button-down button",
      'button[aria-label*="Следующее видео" i]',
      'button[aria-label*="Next video" i]',
      'button[aria-label*="Следующий" i]',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && !el.disabled) return el;
    }
    return null;
  };
  const advance = () => {
    const btn = nextButton();
    if (btn) { btn.click(); return "button"; }
    // Фолбэк: лента Shorts — вертикальный скролл-снап; листаем на высоту окна.
    const scroller = document.querySelector("#shorts-container, ytd-shorts") || document.scrollingElement || document.body;
    if (scroller && typeof scroller.scrollBy === "function") { scroller.scrollBy({ top: window.innerHeight, behavior: "smooth" }); return "scroll"; }
    window.scrollBy(0, window.innerHeight);
    return "scroll";
  };

  // Предусловия проверяем ДО демонтажа прежнего поллера (ревью): иначе неудачный start глушил живое
  // автолистание, оставлял состояние — и status докладывал «листаю», когда уже никто не листает.
  const v0 = pickVideo();
  if (!v0) return { ok: false, code: "not_found", error: "на странице нет видимого видео — открой ленту коротких видео (Shorts) и повтори" };
  if (state && state.timer) clearInterval(state.timer); // рестарт: один поллер на документ

  const maxCount = cfg && cfg.maxCount > 0 ? Math.min(cfg.maxCount, 500) : 50;
  const maxMinutes = cfg && cfg.maxMinutes > 0 ? Math.min(cfg.maxMinutes, 240) : 60;
  const deadline = Date.now() + maxMinutes * 60000;
  // ЯКОРЬ ЛЕНТЫ (ревью): запоминаем, ГДЕ включили. SPA-переход прочь из ленты (тап по каналу, обычное
  // видео) документ не перезагружает — без якоря поллер продолжал бы жить и по концу 40-минутной лекции
  // кликнул бы «Следующее видео», уведя просмотр, которого владелец не просил.
  const anchorHost = location.host;
  const anchorSeg = (location.pathname.split("/")[1] || "").toLowerCase();
  // Ленты коротких видео: ролики КОРОТКИЕ. Длинное видео — не наш случай (не листаем чужой контент).
  const MAX_CLIP_SEC = 300;

  const st = {
    advanced: 0, lastSrc: null, lastT: 0, lastEnded: false, stoppedReason: null, timer: null,
    startedAt: Date.now(), pending: null, failed: 0, lastAdvanceAt: 0,
  };
  const halt = (reason) => { st.stoppedReason = reason; clearInterval(st.timer); st.timer = null; }; // состояние ЖИВЁТ для status
  st.timer = setInterval(() => {
    try {
      if (Date.now() > deadline) return halt("истёк лимит времени");
      // Ушли из ленты (SPA-навигация) — останавливаемся честно, чужой страницей не управляем.
      if (location.host !== anchorHost || (location.pathname.split("/")[1] || "").toLowerCase() !== anchorSeg) {
        return halt("страница ушла из ленты коротких видео");
      }
      const v = pickVideo();
      if (!v) return; // между роликами SPA на миг сносит элемент — ждём следующий тик
      const src = v.currentSrc || v.src || "";
      const dur = Number(v.duration);
      // ПОДТВЕРЖДЕНИЕ переключения (ревью, CRITICAL): advance() возвращает лишь СПОСОБ попытки. Считаем
      // ролик пролистанным ТОЛЬКО когда реально сменился currentSrc — иначе Джарвис рапортовал бы
      // «пролистал 40», пока владелец 40 раз смотрел один и тот же ролик по кругу.
      if (st.pending) {
        if (src && src !== st.pending.src) {
          st.advanced += 1;
          st.failed = 0;
          st.pending = null;
          st.lastSrc = src;
          st.lastT = v.currentTime || 0;
          st.lastEnded = false;
          if (st.advanced >= maxCount) return halt("достигнут лимит роликов");
          return;
        }
        if (Date.now() - st.pending.at < 2500) return; // ждём смены ролика
        st.failed += 1;
        st.pending = null;
        if (st.failed >= 3) return halt("не удалось переключить ролик (кнопка «Следующее» не сработала)");
        return;
      }
      if (src !== st.lastSrc) { st.lastSrc = src; st.lastT = v.currentTime || 0; st.lastEnded = false; return; } // новый ролик
      if (!Number.isFinite(dur) || dur <= 0) return; // длительность ещё не известна
      if (dur > MAX_CLIP_SEC) return; // длинное видео — не лента коротких, не трогаем
      const t = v.currentTime || 0;
      // «Круг завершён»: были у самого конца, а теперь снова у начала ТОГО ЖЕ ролика (loop). ended берём
      // ПО ФРОНТУ (false→true): он залипает до перемотки, и проверка по уровню давала шторм переключений.
      const wrapped = st.lastT >= dur - 0.6 && t < Math.min(1.2, st.lastT);
      const endedEdge = v.ended === true && st.lastEnded === false;
      st.lastEnded = v.ended === true;
      if ((wrapped || endedEdge) && Date.now() - st.lastAdvanceAt > 1500) {
        st.lastMethod = advance();
        st.lastAdvanceAt = Date.now();
        st.pending = { src, at: Date.now() }; // ждём подтверждения смены — счётчик растёт только тогда
        return;
      }
      st.lastT = t;
    } catch (e) {
      halt("ошибка автолистания: " + String((e && e.message) || e));
    }
  }, 400);

  globalThis[KEY] = st;
  return { ok: true, running: true, advanced: 0, maxCount, maxMinutes, note: "листаю следующий ролик, как только текущий доигрывает" };
}

/**
 * §Волна2-веб: БЕРСТ шагов по ref одним вызовом (веб-аналог input_batch). Все шаги адресуют ref из ОДНОГО
 * снимка → стабильный ref делает батч безопасным (каждый шаг сверяет идентичность/gen/isConnected). Пред-
 * валидирует ВСЕ ref ДО первого действия (устаревший снимок не маскируется успехом), исполняет
 * ПОСЛЕДОВАТЕЛЬНО, стоп на первой ошибке, честное «выполнено k из n». Многополевая форма (логин) = 1 раунд.
 */
async function tabBatch(url, steps, tabId, refMode) {
  const tab = await findTargetTab(url, tabId);
  if (!tab || tab.id == null) throw noTabError(url);
  if (tab.status !== "complete") await waitForTabReady(tab.id);
  if (!Array.isArray(steps) || !steps.length) return { ok: false, error: "batch: пустой список шагов" };
  if (steps.length > 12) return { ok: false, error: "batch: максимум 12 шагов за раз (разбей длинный флоу)" };
  // Разбор ref каждого шага. Все шаги ОБЯЗАНЫ адресовать ref из текущего снимка (без ref батч не берём).
  const parsed = [];
  for (const s of steps) {
    const intent = String((s && s.intent) || "");
    const P = s && s.params && typeof s.params === "object" ? s.params : s || {};
    const rawRef = s && s.ref !== undefined && s.ref !== null ? s.ref : P.ref;
    const mm = /^(?:f(\d+))?(e\d+_\d+)$/.exec(String(rawRef || "").trim());
    if (!mm) return { ok: false, error: "batch: шаг «" + intent + "» без валидного ref («" + rawRef + "») — все шаги батча адресуют ref из browser_inspect" };
    parsed.push({ intent, params: P, frame: mm[1] !== undefined ? Number(mm[1]) : 0, localRef: mm[2] });
  }
  // Пред-валидация ВСЕХ ref по фреймам ДО первого действия.
  const byFrame = new Map();
  for (const p of parsed) { if (!byFrame.has(p.frame)) byFrame.set(p.frame, []); byFrame.get(p.frame).push(p.localRef); }
  for (const [fr, refs] of byFrame) {
    const target = fr ? { tabId: tab.id, frameIds: [fr] } : { tabId: tab.id };
    let res;
    try { [res] = await chrome.scripting.executeScript({ target, func: validateRefsIsolated, args: [refs] }); } catch (e) {
      return { ok: false, code: "ref_stale", error: "batch: не смог проверить ref (" + String((e && e.message) || e) + ") — browser_inspect заново" };
    }
    const bad = (res && res.result && res.result.bad) || [];
    if (bad.length) return { ok: false, code: "ref_stale", error: "batch: устаревшие ref " + bad.join(", ") + " — снимок изменился, сделай browser_inspect заново" };
  }
  // Исполнение шагов ПОСЛЕДОВАТЕЛЬНО через штатный ref-путь tabAct (реестр в isolated-world персистит между
  // шагами; навигация внутри батча убивает реестр → следующий ref честно ref_stale и батч честно стопнет).
  const results = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const p = parsed[i];
    const stepParams = { ...p.params, ref: (p.frame ? "f" + p.frame : "") + p.localRef };
    try {
      const r = await tabAct(url, p.intent, stepParams, tabId, true);
      results.push({ step: i, ok: true, intent: p.intent, result: r });
    } catch (e) {
      results.push({ step: i, ok: false, intent: p.intent, error: String((e && e.message) || e) });
      return { ok: false, stoppedAt: i, done: i, total: parsed.length, results, error: "шаг " + (i + 1) + " («" + p.intent + "») не выполнен: " + String((e && e.message) || e) };
    }
  }
  return { ok: true, done: parsed.length, total: parsed.length, results };
}

/**
 * Прощупать ДОЧЕРНИЕ фреймы вкладки: в каком есть цель (selector/text/поле ввода/медиа)? Возвращает
 * {frameId, url} ЛУЧШЕГО фрейма или undefined. Только ПОИСК, без действия. Защиты (ревью):
 *  • приватные/loopback фреймы отбрасываются (SSRF — действие в intranet-iframe);
 *  • выбираем МАКСИМАЛЬНЫЙ по score, а не первый попавшийся (иначе рекламный iframe перехватывал бы);
 *  • слабый матч (ниже порога) не проходит — лучше честный провал, чем клик по рекламе.
 */
async function probeFrames(tabId, spec) {
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probeFindInPage, args: [spec || {}] });
  } catch {
    return undefined;
  }
  let best = null;
  for (const f of frames || []) {
    if (!f || (f.frameId || 0) === 0 || !f.result || !f.result.found) continue; // top не трогаем (там уже искали)
    if (isPrivateHost(f.result.url)) continue; // SSRF: не действуем в приватном/loopback фрейме
    const score = Number(f.result.score) || 0;
    if (!best || score > best.score) best = { frameId: f.frameId, url: f.result.url || "", score };
  }
  return best ? { frameId: best.frameId, url: best.url } : undefined;
}

/**
 * Исполняется ВНУТРИ фрейма (self-contained): есть ли тут цель и НАСКОЛЬКО уверенно (score)? spec:
 * {selector} | {text} | {input:true} | {media:true}. Матч текста зеркалит byText из pageActInPage
 * (fold+скоринг), порог сильный (целое слово/точное — score≥80), чтобы probe не тащил слабый substring
 * из рекламы (ревью #5). media — только ВИДИМЫЙ и КРУПНЫЙ элемент (muted-autoplay трекер отсеян, ревью #2).
 * Shadow DOM обходится, селектор понимает « >>> ». Возвращает {found, score, url}.
 */
function probeFindInPage(spec) {
  const Q = spec || {};
  const here = location.href;
  // probeFrames игнорирует результат top-фрейма (там уже искали) → не тратим deepAll+innerText на тяжёлый
  // top-документ (ревью contested #I). Дешёвый ранний выход; дочерние фреймы сканируются как раньше.
  try { if (window.top === window.self) return { found: false, url: here, top: true }; } catch { /* cross-origin доступ к window.top кинул → мы точно в дочернем фрейме, продолжаем */ }
  const visibleBig = (el, minW, minH) => {
    if (!el) return false;
    const r = el.getClientRects();
    if (!r || !r.length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    const b = el.getBoundingClientRect();
    return b.width >= (minW || 2) && b.height >= (minH || 2);
  };
  try {
    if (Q.media) {
      // РЕАЛЬНЫЙ контентный плеер. VIDEO — видимый и крупный (≥160×90). AUDIO — либо ИГРАЕТ не-muted
      // (активный контент), либо ВИДИМ (есть UI-контейнер). ⚠️ duration>0 НЕ засчитываем: скрытый
      // рекламный/аналитический <audio> с загруженным src (paused, 0×0) иначе проходил как «плеер» и
      // play/pause/seek били в рекламу с ложным observed-успехом (ревью #2/#3). Скрытый paused-контент
      // (редкий SoundCloud-embed без UI) честно не найдётся — лучше провал, чем клик в трекер.
      for (const m of document.querySelectorAll("video, audio")) {
        const okM = m.tagName === "AUDIO" ? (!m.paused && !m.muted) || visibleBig(m, 1, 1) : visibleBig(m, 160, 90);
        if (okM) return { found: true, score: 100, url: here };
      }
      return { found: false, url: here };
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
    const deepAll = (sel) => {
      const out = [];
      const walk = (root) => {
        let list = [];
        try { list = root.querySelectorAll(sel); } catch { /* ignore */ }
        for (const el of list) out.push(el);
        let all = [];
        try { all = root.querySelectorAll("*"); } catch { /* ignore */ }
        for (const h of all) if (h.shadowRoot) walk(h.shadowRoot);
      };
      walk(document);
      return out;
    };
    // Селектор из browser_inspect (точный, включая frameId) — сильный сигнал: если он резолвится тут, это
    // ТОЧНО тот фрейм. Приоритетнее текста; при совпадении даёт максимальный score.
    if (Q.selector) {
      const parts = String(Q.selector).split(/\s*>>>\s*/);
      let scope = document;
      let el = null;
      for (const p of parts) {
        try { el = scope.querySelector(p); } catch { return { found: false, url: here }; }
        if (!el) { el = null; break; }
        scope = el.shadowRoot || el;
      }
      if (el && visible(el)) return { found: true, score: 120, url: here };
      // селектор не резолвится → падаем в текст (если задан), иначе не найдено
      if (!Q.text) return { found: false, url: here };
    }
    if (Q.input) {
      const cands = deepAll('input[type="text"],input[type="search"],input:not([type]),textarea,[contenteditable="true"]');
      const ok = cands.some((n) => { const b = n.getBoundingClientRect(); return b.width > 1 && b.height > 1 && !n.disabled && !n.readOnly; });
      // input-цель СЛАБАЯ (любое поле): даём низкий score, чтобы фрейм с текстовым/селекторным матчем выигрывал.
      return ok ? { found: true, score: 40, url: here } : { found: false, url: here };
    }
    const foldTxt = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[.,!?;:()"'«»\-—–]+/g, " ").replace(/\s+/g, " ").trim();
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const scoreText = (q, hay) => {
      if (!q || !hay) return 0;
      if (hay === q) return 100;
      if (new RegExp("(^| )" + escRe(q) + "( |$)").test(hay)) return 80;
      // ⚠️ Префикс/подстрочные матчи (60/30) в probe НЕ засчитываем: рекламный iframe с «Играть бесплатно»
      // не должен перехватывать click{text:'играть'} (ревью #5). Только точное совпадение или целое слово.
      return 0;
    };
    const t = foldTxt(Q.text || "");
    if (!t) return { found: false, url: here };
    let best = 0;
    for (const e of deepAll("a,button,[role=button],[role=link],[role=tab],[aria-label],[data-test-id],[tabindex]")) {
      if (e.closest && e.closest(".swiper-slide-duplicate")) continue; // зеркалим resolve() (ревью contested)
      if (!visible(e)) continue;
      const s = scoreText(t, foldTxt((e.innerText || "") + " " + (e.getAttribute("aria-label") || "") + " " + (e.title || "")));
      if (s > best) best = s;
    }
    return best >= 80 ? { found: true, score: best, url: here } : { found: false, url: here };
  } catch (e) {
    return { found: false, url: here, error: String((e && e.message) || e) };
  }
}

/**
 * ISOLATED-world: пометить элемент из ref-реестра эфемерным nonce-атрибутом (мост в MAIN для React-клика).
 * Резолв по ИДЕНТИЧНОСТИ + сверка gen/isConnected → устаревший ref = честный ref_stale, НЕ слепой хит.
 * Self-contained (инжектится, без внешних ссылок).
 */
function stampRefIsolated(localRef, nonce) {
  const REG = globalThis.__jarvisRefs;
  if (!REG || !REG.map) return { ok: false, code: "ref_stale", error: "нет реестра снимка (страница перезагрузилась) — сделай browser_inspect заново" };
  const m = /^e(\d+)_/.exec(String(localRef));
  const gen = m ? Number(m[1]) : -1;
  if (REG.gen !== gen) return { ok: false, code: "ref_stale", error: "ref из устаревшего снимка — сделай browser_inspect заново" };
  const el = REG.map.get(localRef);
  if (!el || !el.isConnected) return { ok: false, code: "ref_stale", error: "элемент исчез со страницы — сделай browser_inspect заново" };
  try { el.setAttribute("data-jarvis-act", String(nonce)); } catch { return { ok: false, error: "не смог пометить элемент для клика" }; }
  return { ok: true };
}

/** ISOLATED-world: состояние медиа (ground-truth play/pause). Self-contained. */
function readMediaStateIsolated() {
  const m = document.querySelector("audio, video");
  if (m) return { playing: !m.paused };
  try {
    const s = navigator.mediaSession && navigator.mediaSession.playbackState;
    if (s === "playing") return { playing: true };
    if (s === "paused") return { playing: false };
  } catch { /* ignore */ }
  return {};
}

/** ISOLATED-world: какие из localRefs устарели (gen/isConnected) — пред-валидация батча. Self-contained. */
function validateRefsIsolated(localRefs) {
  const REG = globalThis.__jarvisRefs;
  const bad = [];
  for (const lr of localRefs || []) {
    if (!REG || !REG.map) { bad.push(lr); continue; }
    const m = /^e(\d+)_/.exec(String(lr));
    const gen = m ? Number(m[1]) : -1;
    const el = REG.map.get(lr);
    if (REG.gen !== gen || !el || !el.isConnected) bad.push(lr);
  }
  return { bad };
}

/**
 * ISOLATED-world: действие по ref без MAIN (type/seek/scroll/enter/submit). Резолв по идентичности + gen +
 * isConnected → ref_stale при устаревании. type/enter возвращают STRONG readback (value) — сервер снимает
 * verify-долг только на реальном readback, не на «ok». Self-contained.
 */
async function actByRefIsolated(localRef, intent, params) {
  const P = params || {};
  const REG = globalThis.__jarvisRefs;
  if (!REG || !REG.map) return { ok: false, code: "ref_stale", error: "нет реестра снимка — сделай browser_inspect заново" };
  const m = /^e(\d+)_/.exec(String(localRef));
  const gen = m ? Number(m[1]) : -1;
  if (REG.gen !== gen) return { ok: false, code: "ref_stale", error: "ref из устаревшего снимка — сделай browser_inspect заново" };
  const el = REG.map.get(localRef);
  if (!el || !el.isConnected) return { ok: false, code: "ref_stale", error: "элемент исчез со страницы — сделай browser_inspect заново" };
  const setNativeValue = (node, val) => {
    const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(node, val);
    else node.value = val;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const pressEnter = (node) => {
    for (const t of ["keydown", "keypress", "keyup"]) {
      node.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    const f = node.form || (node.closest && node.closest("form"));
    if (f) { try { f.requestSubmit ? f.requestSubmit() : f.submit(); } catch { /* ignore */ } }
  };
  try {
    if (intent === "scroll") { window.scrollBy(0, Number(P.dy) || 600); return { ok: true }; }
    if (intent === "seek") {
      const md = el.matches && el.matches("audio, video") ? el : (el.querySelector && el.querySelector("audio, video")) || document.querySelector("audio, video");
      if (!md) return { ok: false, error: "нет видео/аудио для перемотки" };
      const to = Number(P.to);
      const sec = Number(P.seconds);
      const dur = Number.isFinite(md.duration) ? md.duration : Infinity;
      md.currentTime = Number.isFinite(to) ? Math.min(Math.max(0, to), dur) : Math.min(Math.max(0, md.currentTime + (Number.isFinite(sec) ? sec : 10)), dur);
      return { ok: true, currentTime: Math.round(md.currentTime) };
    }
    if (intent === "type") {
      try { el.focus(); } catch { /* ignore */ }
      const v = String(P.text != null ? P.text : "");
      if (el.isContentEditable) {
        el.textContent = "";
        if (document.execCommand) document.execCommand("insertText", false, v);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: v }));
      } else {
        setNativeValue(el, v);
      }
      let submitted = false;
      if (P.enter || P.submit) { pressEnter(el); submitted = true; }
      // STRONG readback значения — но password-поле МАСКИРУЕМ (иначе пароль утёк бы в tool_result/логи).
      const isPw = (el.getAttribute("type") || "").toLowerCase() === "password";
      const val = el.isContentEditable ? (el.innerText || "") : (el.value || "");
      return { ok: true, value: isPw ? (val ? "•••" : "") : val.slice(0, 60), submitted };
    }
    if (intent === "enter" || intent === "submit") {
      try { el.focus(); } catch { /* ignore */ }
      pressEnter(el);
      return { ok: true, submitted: true };
    }
    return { ok: false, error: "intent «" + intent + "» не поддержан по ref — используй click/type/seek/scroll/enter" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Исполняется в MAIN-world (видит React-props страницы). РОБАСТ-клик, минующий Swiper-гейт
 * (preventClicks глушит синтетику в capture-фазе → ни el.click(), ни pointer-цепочка не срабатывают).
 * Порядок: React onClick-проп → Enter (role=button/onKeyDown) → полный pointer. Для встряхивания
 * (expectChange) сверяет, что контент РЕАЛЬНО изменился — иначе честный провал (не врём «готово»).
 * P.nonce → клик по помеченному ref-элементу (мост из ISOLATED). Также «вруби/открой волну» (НЕ refMode) →
 * надёжный переход на Вайб. Функция статична → CSP-safe.
 */
async function robustClickMain(params) {
  const P = params || {};
  const lc = (s) => String(s || "").toLowerCase();
  const t = lc(P.text || "");
  const isShake = /встрях|стряхн|обнов/.test(t);
  // Яндекс-навигация «вруби волну» — ГЕЙТ на !refMode: при refMode доменное знание приходит рецептом-хинтом
  // (модель сама делает browser_open music.yandex.ru + play), а не хардкодом в движке. refMode off → как раньше.
  if (!P.refMode && /yandex/i.test(location.host) && !isShake && /(волна|вайб|vibe)/.test(t)) {
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
  // SHADOW DOM: кандидаты собираются сквозь открытые shadow root'ы; селектор понимает « host >>> inner »
  // (форма из browser_inspect) — обычный querySelector в shadow не заглядывает.
  const deepAll = (sel) => {
    const out = [];
    const walk = (root) => {
      let list = [];
      try { list = root.querySelectorAll(sel); } catch { /* ignore */ }
      for (const e of list) out.push(e);
      let all = [];
      try { all = root.querySelectorAll("*"); } catch { /* ignore */ }
      for (const h of all) if (h.shadowRoot) walk(h.shadowRoot);
    };
    walk(document);
    return out;
  };
  const bySelector = (sel) => {
    const parts = String(sel).split(/\s*>>>\s*/);
    let scope = document;
    let el = null;
    for (const p of parts) {
      try { el = scope.querySelector(p); } catch { return null; }
      if (!el) return null;
      scope = el.shadowRoot || el;
    }
    return el;
  };
  const resolve = () => {
    if (P.nonce) {
      // Клик по ref: элемент помечен data-jarvis-act=nonce (stampRefIsolated в ISOLATED). Ищем СКВОЗЬ shadow.
      // Ровно 1 матч (0 → узел ушёл; >1 → page скопировала атрибут, анти-hijack) — иначе честный провал ниже.
      const hits = deepAll('[data-jarvis-act="' + P.nonce + '"]');
      return hits.length === 1 ? hits[0] : null;
    }
    if (P.selector) return bySelector(P.selector);
    const q = foldTxt(P.text || "");
    if (!q) return null;
    let best = null;
    let bestScore = 0;
    for (const e of deepAll("a,button,[role=button],[role=link],[role=tab],[aria-label],[data-test-id],[tabindex]")) {
      // isConnected вместо document.contains: contains НЕ пересекает shadow-границу (ложно отсекал бы shadow-элементы)
      if (!e.isConnected) continue;
      if (e.closest && e.closest(".swiper-slide-duplicate")) continue;
      if (!visible(e)) continue;
      const s = scoreText(q, foldTxt((e.innerText || "") + " " + (e.getAttribute("aria-label") || "") + " " + (e.title || "")));
      if (s > bestScore) { bestScore = s; best = e; }
    }
    return best;
  };
  let node = resolve();
  if (P.nonce) {
    // ref-клик: 0/≥1 матч по nonce → узел устарел/скопирован → честный ref_stale (не слепой хит). Иначе снимаем метку.
    if (!node) return { ok: false, code: "ref_stale", error: "элемент по ref не найден для клика (страница перерисовалась между снимком и кликом) — сделай browser_inspect заново" };
    try { node.removeAttribute("data-jarvis-act"); } catch { /* ignore */ }
  }
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
  // code:"not_found" → tabAct.shouldProbe щупает iframe (элемент мог жить во фрейме). expectChange-провал
  // ниже помечается code:"no_effect" (клик УЖЕ отработал → повтор в iframe = двойной side-effect, ревью #C).
  if (!node) return { ok: false, code: "not_found", error: "элемент «" + (P.selector || P.text || "") + "» не найден" };
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
  // §Волна2 (2.1) fused act+observe: сигнатуру контента снимаем ВСЕГДА — обычный клик тоже честно
  // рапортует changed:true/false (страница отреагировала или нет) в том же ответе, без отдельного
  // раунда сверки. expectChange-режим (жёсткий: не изменилось = провал) не тронут.
  const before = sigOf();
  // SPA-роутинг (pushState) не убивает контекст → переход виден по location.href; жёсткую навигацию
  // (контекст умер) ловит SW-обёртка runInPage. navigated = содержательный readback (сервер снимет verify-долг).
  const hrefBefore = location.href;
  const withNav = (res) => {
    if (location.href !== hrefBefore) res.navigated = location.href;
    return res;
  };

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
      if (sigOf() !== before) return withNav({ ok: true, method: m.name, changed: true });
    } else if (fired) {
      // §Волна2 (2.1): DOM-диф в том же ответе — подождать реакцию страницы и честно доложить,
      // изменился ли контент (changed:false = клик прошёл, но страница не отреагировала — модель
      // видит это сразу и не ждёт отдельного verify-раунда, чтобы узнать).
      await new Promise((r) => setTimeout(r, 500));
      return withNav({ ok: true, method: m.name, changed: sigOf() !== before });
    }
  }
  if (P.expectChange) {
    // no_effect: элемент НАЙДЕН и клик отработал (3 метода), но контент не сменился — probe iframe НЕ запускаем
    // (иначе клик задублируется в другом документе). Честный провал в top.
    return { ok: false, code: "no_effect", error: "действие не дало эффекта: перепробовал React-onClick, Enter и клик, но контент не изменился (возможно, кнопка не та или волна неактивна)" };
  }
  // used=null: элемент найден, но НИ ОДИН метод не выстрелил (редко) — это тоже «отработали в top», не not_found.
  return used ? withNav({ ok: true, method: used }) : { ok: false, code: "no_effect", error: "не удалось кликнуть по «" + (P.selector || P.text || "") + "»" };
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

  // Плеера в ЭТОМ документе нет вообще (ни медиа, ни кнопки) → code:"not_found" → tabAct прощупает iframe
  // (YouTube-встройка и т.п.). Без этого «pause» на странице без плеера ложно возвращал «уже на паузе»
  // (realPlaying()=false) — ложный успех + probe не запускался, реальный плеер во фрейме играл (ревью #B).
  if (!m && !playBtn() && !pauseBtn()) return { ok: false, code: "not_found", error: "плеер не найден в этом документе" };

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

/**
 * Исполняется ВНУТРИ страницы (и каждого iframe при allFrames): читаемый текст + структура (h1-h3).
 * query — ключевые слова: остаются ТОЛЬКО строки-совпадения с контекстом ±1 (страница целиком не влезает
 * в кап — раньше «current track title» получал хвост шапки, а не нужный блок). Пустой query или ноль
 * совпадений → общий дамп (filtered:false — сервер честно скажет «фильтр не выделил»).
 */
function readPageInPage(query) {
  const fold = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");
  const main = document.querySelector("main, article, [role=main]") || document.body;
  const raw = ((main && main.innerText) || "").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const headings = [...document.querySelectorAll("h1, h2, h3")]
    .map((h) => (h.innerText || "").replace(/\s+/g, " ").trim())
    .filter((t) => t && t.length <= 120)
    .slice(0, 30);
  let text = raw;
  let filtered = false;
  const terms = fold(query).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
  if (terms.length) {
    const lines = raw.split("\n");
    const keep = new Set();
    for (let i = 0; i < lines.length; i += 1) {
      const f = fold(lines[i]);
      if (terms.some((t) => f.includes(t))) { keep.add(i - 1); keep.add(i); keep.add(i + 1); }
    }
    if (keep.size) {
      const idx = [...keep].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b);
      const parts = [];
      let prev = -2;
      for (const i of idx) {
        if (i > prev + 1) parts.push("…");
        parts.push(lines[i]);
        prev = i;
      }
      text = parts.join("\n");
      filtered = true;
    }
  }
  // fix 2026-07-15: ВСЕГДА отдаём состояние медиа из DOM (video.currentTime/duration/paused). Раньше агент
  // читал ВРЕМЯ из видимого таймера (innerText/OCR), а его сайты (YouTube и др.) ПРЯЧУТ при простое мыши →
  // «не видит время без движения мышкой». currentTime — DOM-свойство, доступно ВСЕГДА, без видимого UI.
  let media = null;
  const areaOf = (m) => { try { const r = m.getBoundingClientRect(); return (r.width || 0) * (r.height || 0); } catch { return 0; } };
  // ГЕЙТ видимости+размера (ревью 2026-07-15): 1×1-трекеры / display:none / visibility:hidden / opacity:0 /
  // скрытый preload — ВОН, иначе играющая реклама/трекер выигрывала бы у основного видео. Аудио (без
  // визуального размера) оставляем как валидный плеер.
  const visibleMedia = [...document.querySelectorAll("video, audio")].filter((m) => {
    try {
      // Аудио (в т.ч. БЕЗ controls: у Chromium UA-стиль `audio:not([controls]){display:none}`) — валидный
      // плеер без визуального размера; проверяем ДО display, иначе кастомные аудио-плееры выбрасывались бы.
      if (m.tagName === "AUDIO") return true;
      const st = getComputedStyle(m);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = m.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false;
      if (parseFloat(st.opacity || "1") < 0.1) return false;
      return true;
    } catch { return true; }
  });
  if (visibleMedia.length) {
    // ОСНОВНОЙ плеер = самый КРУПНЫЙ видимый (ревью-фикс: играющий НЕ доминирует над площадью — целевое видео
    // могло быть на ПАУЗЕ, а посторонний ad/hero-луп играть). Тай-брейкеры: длительность (контент длиннее
    // короткого ad/loop), затем звук (не muted). Порог площади 100 — заметная разница решает сразу.
    const dur = (m) => (Number.isFinite(m.duration) ? m.duration : 0);
    const m = visibleMedia.slice().sort((a, b) => {
      const da = areaOf(b) - areaOf(a);
      if (Math.abs(da) > 100) return da;
      const dd = dur(b) - dur(a);
      if (Math.abs(dd) > 1) return dd;
      return (a.muted ? 1 : 0) - (b.muted ? 1 : 0);
    })[0];
    const fmt = (s) => { if (!Number.isFinite(s)) return null; const t = Math.floor(s); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
    media = {
      currentTime: Math.round(m.currentTime),
      currentTimeLabel: fmt(m.currentTime),
      duration: Number.isFinite(m.duration) ? Math.round(m.duration) : null,
      durationLabel: fmt(m.duration),
      paused: m.paused,
      area: Math.round(areaOf(m)), // для межкадрового выбора в tabRead
    };
  }
  return { title: document.title || "", url: location.href, text: text.slice(0, 8000), headings, filtered, ...(media ? { media } : {}) };
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
  // SHADOW DOM: кандидаты сквозь открытые shadow root'ы + селектор « host >>> inner » из browser_inspect.
  const deepAll = (sel) => {
    const out = [];
    const walk = (root) => {
      let list = [];
      try { list = root.querySelectorAll(sel); } catch { /* ignore */ }
      for (const e of list) out.push(e);
      let all = [];
      try { all = root.querySelectorAll("*"); } catch { /* ignore */ }
      for (const h of all) if (h.shadowRoot) walk(h.shadowRoot);
    };
    walk(document);
    return out;
  };
  const bySelector = (sel) => {
    const parts = String(sel).split(/\s*>>>\s*/);
    let scope = document;
    let el = null;
    for (const p of parts) {
      try { el = scope.querySelector(p); } catch { return null; }
      if (!el) return null;
      scope = el.shadowRoot || el;
    }
    return el;
  };
  const byText = (t) => {
    const q = foldTxt(t);
    if (!q) return null;
    let best = null;
    let bestScore = 0;
    for (const e of deepAll("a,button,[role=button],[role=link],[role=tab],[aria-label],[data-test-id]")) {
      if (!visible(e)) continue;
      const s = scoreText(q, foldTxt((e.innerText || "") + " " + (e.getAttribute("aria-label") || "") + " " + (e.title || "")));
      if (s > bestScore) { bestScore = s; best = e; }
    }
    return best;
  };
  // ОСНОВНОЙ плеер = самый КРУПНЫЙ ВИДИМЫЙ video/audio (ревью 2026-07-15): раньше брали ПЕРВЫЙ в DOM →
  // 1×1-трекер / hero-луп в начале страницы перехватывал readMedia (wait_for browser читал не то видео →
  // условие никогда не met) и seek (перематывал рекламу). Гейт видимости+размера + площадь-первичный ключ,
  // длительность/звук — тай-брейкеры. Нет видимого — фолбэк на первый (скрытый плеер лучше, чем ничего для seek).
  const media = () => {
    const areaOf = (m) => { try { const r = m.getBoundingClientRect(); return (r.width || 0) * (r.height || 0); } catch { return 0; } };
    const all = [...document.querySelectorAll("video, audio")].filter((m) => {
      try {
        if (m.tagName === "AUDIO") return true;
        const st = getComputedStyle(m);
        if (st.display === "none" || st.visibility === "hidden") return false;
        const r = m.getBoundingClientRect();
        if (r.width <= 2 || r.height <= 2) return false;
        if (parseFloat(st.opacity || "1") < 0.1) return false;
        return true;
      } catch { return true; }
    });
    if (!all.length) return document.querySelector("video, audio");
    const dur = (m) => (Number.isFinite(m.duration) ? m.duration : 0);
    return all.slice().sort((a, b) => {
      const da = areaOf(b) - areaOf(a);
      if (Math.abs(da) > 100) return da;
      const dd = dur(b) - dur(a);
      if (Math.abs(dd) > 1) return dd;
      return (a.muted ? 1 : 0) - (b.muted ? 1 : 0);
    })[0];
  };
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
  // H2: поле ввода. С selector — точно (вкл. shadow « >>> »); без — ПЕРВОЕ видимое осмысленное поле
  // (НЕ document.body/activeElement), сквозь shadow DOM.
  const findInput = (sel) => {
    if (sel) return bySelector(String(sel));
    const cands = deepAll('input[type="text"],input[type="search"],input:not([type]),textarea,[contenteditable="true"]');
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
      if (!m) return { ok: false, code: "not_found", error: "на странице нет видео/аудио для перемотки" };
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
      // ГЕЙТ на !refMode: при refMode это знание приходит рецептом-хинтом (модель сама делает browser_open),
      // а не хардкодом в движке — общий механизм вместо site-specific ветки. refMode off → как раньше.
      if (!P.refMode && /yandex/i.test(location.host) && !isShake && /(волна|вайб|vibe)/.test(t)) {
        const onVibe = /\/vibe\b/.test(location.pathname) || location.pathname === "/";
        if (!onVibe) { location.href = "https://music.yandex.ru/"; return { ok: true, navigated: "vibe", note: "перешёл на «Мою волну» (Вайб); теперь play" }; }
        return { ok: true, already: "vibe", note: "уже на «Моей волне»; нужен play" };
      }
      const finder = () => (P.selector ? bySelector(String(P.selector)) : byText(P.text));
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
      // code:"not_found" → tabAct прощупает iframe (поле embed-формы). Поле есть только в чужом фрейме —
      // tabAct вернёт frame/frameUrl, модель увидит КУДА ввела (ревью #3a).
      if (!el) return { ok: false, code: "not_found", error: "поле ввода не найдено — укажи selector (browser_inspect показывает поля)" };
      el.focus();
      const v = String(P.text ?? "");
      if (el.isContentEditable) {
        el.textContent = "";
        if (document.execCommand) document.execCommand("insertText", false, v);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: v }));
      } else {
        setNativeValue(el, v); // H1: нативный сеттер — держится на React-инпутах
      }
      // C3: ввод+поиск за один вызов, если просили {enter:true} / {submit:true}. Ввод и Enter в ОДНОМ
      // вызове идут в ОДИН документ (эта функция целиком перезапускается в найденном фрейме) — рассинхрон
      // «type в iframe, enter в top» тут невозможен (ревью #3), в отличие от раздельных type→enter.
      const submitted = P.enter || P.submit ? pressEnter(el) : false;
      return { ok: true, typed: v.slice(0, 60), submitted };
    }
    if (intent === "enter" || intent === "submit") {
      // C3: нажать Enter / отправить форму (запустить поиск после type). selector опционален (вкл. shadow « >>> »).
      const el = P.selector ? bySelector(String(P.selector)) : document.activeElement;
      const ae = el || document.activeElement;
      // ЧЕСТНОСТЬ (ревью #3b): без selector, если фокус в ДРУГОМ фрейме (activeElement === <iframe>) или его
      // нет (body/null) — Enter уйдёт «в никуда» (событие на iframe внутрь не проникает). Не врём submitted:true.
      if (!P.selector && (!ae || ae === document.body || ae.tagName === "IFRAME" || ae.tagName === "FRAME")) {
        return { ok: false, code: "not_found", error: "нет сфокусированного поля для Enter (фокус вне этого документа или отсутствует). Объедини ввод и отправку одним вызовом: browser_act{type, text, enter:true}; либо передай selector/frameId поля." };
      }
      pressEnter(ae);
      return { ok: true, submitted: true };
    }
    if (intent === "readMedia") {
      // ЧТЕНИЕ состояния медиа (fix 2026-07-15: серверная проверка «видео дошло до N секунд» вместо
      // хрупкого OCR таймера). media() уже в scope (video/audio). Возвращаем позицию/длительность/паузу.
      const m = media();
      if (!m) return { ok: false, code: "not_found", error: "на странице нет video/audio" };
      return { ok: true, currentTime: m.currentTime, duration: Number.isFinite(m.duration) ? m.duration : null, paused: m.paused };
    }
    if (intent === "getValue") {
      // Обобщённое чтение свойства DOM-элемента (selector.prop). Для не-медийных ожиданий.
      const el = P.selector ? bySelector(String(P.selector)) : media();
      if (!el) return { ok: false, code: "not_found", error: "элемент не найден" };
      const prop = String(P.prop || "textContent");
      // БЕЗОПАСНОСТЬ (ревью 2026-07-15): маскируем ЗНАЧЕНИЕ поля пароля и РЕЖЕМ длину — как соседние
      // readback-пути (inspect/type). Иначе секрет / огромный textContent утёк бы СЫРЫМ в tool_result,
      // серверный лог и durable data/watches.json.
      const isPw = el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password";
      if (isPw && (prop === "value" || prop === "textContent")) return { ok: true, value: el.value ? "•••" : "", len: el.value ? 3 : 0 };
      const raw = el[prop];
      const out = typeof raw === "object" ? String(raw) : raw;
      if (typeof out !== "string") return { ok: true, value: out };
      // 🔴 ПОИСК ПОДСТРОКИ ДЕЛАЕТСЯ ЗДЕСЬ, ПО ПОЛНОМУ ТЕКСТУ (ревью 2026-07-24, CRITICAL — первопричина
      // «не сказал про доставку»): наружу значение отдаётся ОБРЕЗАННЫМ (кап 200 симв. против утечки
      // секретов и раздувания durable-стора), поэтому серверное `contains` по обрезку НИКОГДА не находило
      // слово, стоящее дальше 200-го символа — статус «Доставлен» на реальной странице заказа именно там.
      // Теперь сервер передаёт искомую подстроку сюда, а мы возвращаем ЧЕСТНЫЙ matched по всему тексту +
      // короткий сниппет-контекст вокруг совпадения (для человекочитаемого detail, без слива страницы).
      const needle = typeof P.contains === "string" ? P.contains : "";
      const len = out.length;
      // blank = страница ПУСТА ПО СУТИ. Считаем по TRIM (ревью 2026-07-24): выгруженная вкладка отдаёт
      // не "", а «\n   \n  \n» — по сырой длине это «непусто», и слепота снова маскировалась бы под
      // честное «условие не выполнено» (ровно симптом живого эпизода с доставкой).
      const blank = out.trim() === "";
      if (needle) {
        const at = out.toLowerCase().indexOf(needle.toLowerCase());
        const snippet =
          at >= 0 ? out.slice(Math.max(0, at - 40), Math.min(len, at + needle.length + 40)).trim() : out.slice(0, 200);
        return { ok: true, value: snippet, matched: at >= 0, len, blank };
      }
      return { ok: true, value: out.slice(0, 200), len, blank };
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
  // аудит-2 [3]: openTgTab() ВНУТРИ try — иначе его throw (окно не открылось/waitTabComplete reject) минует
  // finally и оставит keep-alive interval висеть навсегда (пинит SW). closeTgTab(undefined) безопасен.
  let h;
  try {
    h = await openTgTab();
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
  let h; // аудит-2 [3]: openTgTab внутри try — иначе его throw оставит keep-alive interval висеть
  try {
    h = await openTgTab();
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

/** Хосты календарей, которые умеем читать из уже открытой вкладки (расширять — строкой сюда). */
const CALENDAR_TAB_PATTERNS = [
  "*://calendar.google.com/*",
  "*://calendar.yandex.ru/*",
  "*://calendar.yandex.com/*",
  "*://outlook.live.com/calendar/*",
  "*://outlook.office.com/calendar/*",
  "*://outlook.office365.com/calendar/*",
];

/**
 * D-4: события календаря из УЖЕ ОТКРЫТОЙ вкладки (Google/Яндекс/Outlook) — БЕЗ OAuth, в сессии
 * владельца. Ambient зовёт с open=false (неинвазивно: нет вкладки → {noTab:true}, окна не создаём).
 * Явная просьба владельца («какие у меня встречи?») идёт с open=true — тогда открываем ФОНОВУЮ
 * вкладку (active:false — фокус не крадём) и ждём отрисовки.
 * ЧЕСТНОСТЬ: пустая (выгруженная) страница → {ok:false, blank:true}, а НЕ «событий нет».
 */
async function calendarRead(open) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: CALENDAR_TAB_PATTERNS });
  } catch (e) { return { ok: false, error: "tabs.query: " + (e && e.message) }; }
  // Кандидатов пробуем по очереди и берём ПЕРВОГО, где нашлись элементы событий (та же грабля, что у
  // почты: под паттерн может попасть служебная страница вендора, а настоящий календарь — второй).
  const cands = tabs.filter((t) => t.id !== undefined);
  if (cands.length === 0 && !open) return { ok: true, noTab: true, events: [] }; // неинвазивно
  const readTab = async (t, created) => {
    try {
      // Chrome выгрузил фоновую вкладку — оживляем, иначе прочитаем пустоту и решим «встреч нет».
      if (t.discarded) { await chrome.tabs.reload(t.id); await waitTabComplete(t.id, 20000); await sleep(1500); }
      const results = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: calendarEventsInPage });
      const out = (results && results[0] && results[0].result) || { ok: false, error: "нет результата" };
      if (created) out.openedTab = true;
      return out;
    } catch (e) {
      return { ok: false, error: "scripting: " + (e && e.message) };
    }
  };
  let best = null;
  for (const t of cands.slice(0, 4)) {
    const out = await readTab(t, false);
    if (out && out.ok && Array.isArray(out.events) && out.events.length > 0) return out;
    if (!best || (out && out.ok && !best.ok)) best = out;
  }
  if (best) return best;
  try {
    const t = await chrome.tabs.create({ url: "https://calendar.google.com/calendar/r/day", active: false });
    await waitTabComplete(t.id, 20000);
    await sleep(1500); // SPA дорисовывает сетку уже после complete
    return await readTab(t, true);
  } catch (e) { return { ok: false, error: "tabs.create: " + (e && e.message) }; }
}

/**
 * Внутри вкладки календаря (self-contained — executeScript сериализует функцию без замыканий):
 * собрать чипы событий с их aria-label. Разбор в момент времени делает СЕРВЕР (чистая функция,
 * покрыта тестами) — здесь только сбор сырья, чтобы разметка одного вендора не диктовала логику.
 */
function calendarEventsInPage() {
  try {
    const text = (document.body ? document.body.innerText || "" : "").trim();
    // Выгруженная/не отрисованная вкладка: честное «не прочитал», а не спокойное «встреч нет».
    if (!text) return { ok: false, blank: true, error: "страница пуста (вкладка выгружена или не отрисована)" };
    const nodes = [].slice.call(document.querySelectorAll(
      '[data-eventid], [data-eventchip], [role="gridcell"] [role="button"][aria-label], [role="listitem"][aria-label], [role="row"][aria-label]',
    ));
    const seen = {};
    const events = [];
    for (let i = 0; i < nodes.length && events.length < 60; i += 1) {
      const el = nodes[i];
      const label = ((el.getAttribute("aria-label") || el.textContent || "") + "").replace(/\s+/g, " ").trim();
      if (label.length < 3) continue;
      // День-контейнер: подпись даты и признак «сегодня» (запасной источник даты для сервера).
      let day = "", today = false, p = el;
      for (let d = 0; d < 8 && p; d += 1) {
        p = p.parentElement;
        if (!p || !p.getAttribute) break;
        if (p.getAttribute("aria-current") === "date") today = true;
        const cls = typeof p.className === "string" ? p.className : "";
        if (/(^|[\s_-])today([\s_-]|$)/i.test(cls)) today = true;
        if (!day) {
          const dl = p.getAttribute("data-date") || (p.getAttribute("role") === "gridcell" ? p.getAttribute("aria-label") : "");
          if (dl) day = (dl + "").replace(/\s+/g, " ").trim().slice(0, 80);
        }
      }
      const key = label.slice(0, 120) + "|" + day;
      if (seen[key]) continue;
      seen[key] = 1;
      events.push({ label: label.slice(0, 200), day: day, today: today });
    }
    return { ok: true, events: events, text: text.replace(/\n{3,}/g, "\n\n").slice(0, 4000), host: location.hostname };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** Хосты почты, которые умеем читать из уже открытой вкладки (расширять — строкой сюда). */
const MAIL_TAB_PATTERNS = [
  "*://mail.google.com/*",
  "*://mail.yandex.ru/*",
  "*://mail.yandex.com/*",
  "*://mail.ru/*",
  "*://e.mail.ru/*",
  "*://outlook.live.com/mail/*",
  "*://outlook.office.com/mail/*",
  "*://outlook.office365.com/mail/*",
];

/**
 * Похож ли URL на список ВХОДЯЩИХ. Gmail без хеша (`/mail/u/0/`) — тоже входящие; «Отправленные»,
 * «Черновики», ярлыки и категории — нет. Используется и при ВЫБОРЕ вкладки, и внутри страницы, чтобы
 * сервер знал: пустой список непрочитанных получен из входящих (тогда «писем нет» — правда) или из
 * другой папки (тогда это НЕ ответ на вопрос владельца).
 */
function looksLikeInbox(u) {
  const s = (u || "") + "";
  if (/(#|\/)(inbox|входящие)/i.test(s)) return true;
  if (/(#|\/)(sent|drafts|spam|trash|archive|junk|outbox|отправленные|черновики|спам|корзина)/i.test(s)) return false;
  if (/#(category|label|search|settings)/i.test(s)) return false;
  return /mail\.google\.com\/mail\/[^#]*$/i.test(s); // Gmail без хеша = входящие
}

/**
 * D-5: НЕПРОЧИТАННЫЕ письма из УЖЕ ОТКРЫТОЙ вкладки почты — без OAuth, в сессии владельца.
 * Правила те же, что у календаря: ambient зовёт с open=false (нет вкладки → {noTab:true}), явная
 * просьба — с open=true (фоновая вкладка, фокус не крадём). Пустая страница → {blank:true}, НЕ «писем нет».
 * ⚠️ ЧИТАЕМ ТОЛЬКО СПИСОК (отправитель/тема/сниппет) — тело письма не трогаем: в ambient оно не нужно,
 * а утечка его в промпт — лишний вектор инъекции.
 */
async function mailRead(open) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: MAIL_TAB_PATTERNS });
  } catch (e) { return { ok: false, error: "tabs.query: " + (e && e.message) }; }
  // Предпочитаем вкладку со ВХОДЯЩИМИ (контроль-6): открытые «Отправленные»/«Промоакции» разбираются
  // успешно и дают ПУСТОЙ список непрочитанных → сервер уверенно говорил «писем нет» при полном ящике.
  // ВЫБИРАЕМ ВКЛАДКУ ПО ФАКТУ РАЗБОРА, а не по URL (живой прогон 2026-07-29): у владельца под паттерн
  // `mail.google.com/*` попала СТРАНИЦА РЕГИСТРАЦИИ Gmail, а настоящая почта (e.mail.ru) осталась в
  // стороне — «предпочтение входящих» по URL выбрало именно мусорную вкладку и D-5 читала не то.
  // Поэтому пробуем кандидатов по очереди (сперва похожие на входящие) и берём ПЕРВУЮ, где список
  // реально разобрался; если нигде — отдаём первый ответ (честный текст-фолбэк).
  const cands = [
    ...tabs.filter((t) => t.id !== undefined && looksLikeInbox(t.url)),
    ...tabs.filter((t) => t.id !== undefined && !looksLikeInbox(t.url)),
  ];
  if (cands.length === 0 && !open) return { ok: true, noTab: true, mail: [] };
  const readTab = async (t, created) => {
    try {
      if (t.discarded) { await chrome.tabs.reload(t.id); await waitTabComplete(t.id, 20000); await sleep(1500); }
      const results = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: mailUnreadInPage });
      const out = (results && results[0] && results[0].result) || { ok: false, error: "нет результата" };
      if (created) out.openedTab = true;
      // Какую папку читали (решает СЕРВЕР, вправе ли он говорить «писем нет»).
      if (out && out.ok) out.inbox = looksLikeInbox(t.url);
      return out;
    } catch (e) {
      return { ok: false, error: "scripting: " + (e && e.message) };
    }
  };
  let best = null;
  for (const t of cands.slice(0, 4)) {
    const out = await readTab(t, false);
    if (out && out.ok && out.recognized) return out; // список реально разобран — это она
    if (!best || (out && out.ok && !best.ok)) best = out;
  }
  if (best) return best;
  try {
    const t = await chrome.tabs.create({ url: "https://mail.google.com/mail/u/0/#inbox", active: false });
    await waitTabComplete(t.id, 20000);
    await sleep(1500);
    return await readTab(t, true);
  } catch (e) { return { ok: false, error: "tabs.create: " + (e && e.message) }; }
}

/**
 * Внутри вкладки почты (self-contained): собрать НЕПРОЧИТАННЫЕ письма списка.
 * Gmail помечает непрочитанную строку классом zE, Яндекс/Mail.ru — «unread» в классе, Outlook — в aria-label.
 * Ничего не узнали → отдаём сырой текст: пусть модель читает сама (это честнее, чем «писем нет»).
 */
function mailUnreadInPage() {
  try {
    const text = (document.body ? document.body.innerText || "" : "").trim();
    if (!text) return { ok: false, blank: true, error: "страница пуста (вкладка выгружена или не отрисована)" };
    // ВЕНДОРНЫЕ селекторы строк списка — по ним же судим, «узнали ли мы вёрстку». Катч-олл `[aria-label]`
    // отсюда УБРАН: он матчит пол-страницы, поэтому «строки нашлись» переставало что-либо значить.
    // ⚠️ Mail.ru (e.mail.ru) добавлен по ЖИВОМУ прогону 2026-07-29: у владельца открыт именно он, и
    // прежние селекторы (Gmail/Яндекс/Outlook) его не узнавали — D-5 честно падала в текст-фолбэк.
    // Классы `llc`/`ll-crpt`/`ll-sj` НЕ подтверждены живым inspect (React, DOM закрыт) — если промах,
    // `recognized` останется false и поведение не изменится (тот же честный фолбэк), поэтому добавление
    // безопасно; подтвердить/поправить — на живой странице владельца.
    const rows = [].slice.call(document.querySelectorAll(
      'tr.zA, [class*="MessageSnippet" i], [class*="messageLine" i], [class*="llc" i], [data-convid], [role="row"]',
    ));
    const clean = (s) => ((s || "") + "").replace(/\s+/g, " ").trim();
    // ⚠️ ТОЛЬКО валидные CSS-матчеры (=, ~=, |=, ^=, $=, *=): «+=» не существует, и ОДИН такой терм
    // делает невалидным ВЕСЬ список → querySelector бросает SyntaxError на первой же строке (D-5
    // «работала», лишь пока писем не было). Список селекторов не forgiving.
    const fieldsOf = (el) => {
      const fromEl = el.querySelector(
        '[email], .yW span[name], .zF, [class*="-from" i], [class*="sender" i], [class*="Sender" i], [class*="ll-crpt" i], [class*="correspondent" i]',
      );
      const subjEl = el.querySelector('.bog, [class*="subject" i], [class*="Subject" i], [class*="ll-sj" i]');
      const from = clean(fromEl ? fromEl.getAttribute("name") || fromEl.getAttribute("email") || fromEl.textContent : "").slice(0, 60);
      const subject = clean(subjEl ? subjEl.textContent : "").slice(0, 120);
      return { from: from, subject: subject };
    };
    const seen = {};
    const mail = [];
    let parsedRows = 0; // строк, из которых РЕАЛЬНО достали отправителя/тему — этим и меряем «узнали вёрстку»
    let unreadTotal = 0; // всего непрочитанных (может быть больше отданных 25 — см. `truncated`)
    for (let i = 0; i < rows.length; i += 1) {
      const el = rows[i];
      const f = fieldsOf(el);
      if (f.from || f.subject) parsedRows += 1;
      const cls = typeof el.className === "string" ? el.className : "";
      const aria = el.getAttribute ? el.getAttribute("aria-label") || "" : "";
      // Признак непрочитанного у разных вендоров.
      const unread =
        /(^|\s)zE(\s|$)/.test(cls) ||                       // Gmail
        /unread|_unread|is-unread/i.test(cls) ||            // Яндекс/Mail.ru
        /непрочит|unread/i.test(aria);                      // Outlook/локализации
      if (!unread) continue;
      unreadTotal += 1; // считаем ДО разбора полей: непрочитанная строка не должна пропасть из счёта
      if (!f.from && !f.subject) continue;
      const key = f.from + "|" + f.subject;
      if (seen[key]) continue;
      seen[key] = 1;
      if (mail.length < 25) mail.push({ from: f.from, subject: f.subject }); // кап отдачи, но СЧИТАЕМ все
    }
    // «ВЁРСТКУ УЗНАЛИ» = сумели ВЫТАЩИТЬ СОДЕРЖИМОЕ хотя бы одной строки, а НЕ «нашлись элементы,
    // похожие на строки» (контроль-5, HIGH: `rows.length > 0` матчился любым `[role="row"]`, поля же
    // тянутся ДРУГИМИ селекторами — на Outlook с обфусцированными классами получалось recognized:true
    // + пустой список → уверенное «Непрочитанных писем нет» при полном ящике, без текста-фолбэка и без
    // деградации). Разобрали хоть одну строку → селекторы работают → пустому списку можно верить.
    const recognized = parsedRows > 0;
    // ...НО «умеем читать строки» ещё НЕ значит «умеем отличать непрочитанное» (контроль-10): это
    // РАЗНЫЕ семейства селекторов. Если маркер непрочитанного у вендора другой (React-бейдж, data-*),
    // мы получим пустой список при полном ящике — и уверенное «писем нет» будет ЛОЖЬЮ. Поэтому отдаём
    // отдельный признак: убедились ли мы, что понимаем маркер. Gmail (строки tr.zA) — конвенция zE
    // проверена; на прочих вендорах уверены, только если реально видели непрочитанную строку.
    const gmailRows = document.querySelector("tr.zA") !== null;
    const markerConfident = gmailRows || unreadTotal > 0;
    // ПРИВАТНОСТЬ: сырой текст страницы отдаём ТОЛЬКО когда список распознать не удалось (иначе он не
    // нужен), и это ЧЕСТНО объявлено вызывающему через `textIsWholePage`. Финальное ревью (MEDIUM):
    // раньше innerText уходил ВСЕГДА — при открытом письме в облако уезжало его ТЕЛО и цитируемая
    // переписка, хотя схема инструмента обещала «тело писем НЕ читается». Обещание должно совпадать с
    // поведением: либо не тянем, либо говорим прямо.
    // Вёрстка узнана (разобрали содержимое строк) → отдаём ТОЛЬКО список, даже если он пуст. Текст
    // страницы (а с ним тело открытого письма) не покидает машину.
    // `unreadTotal`/`truncated` — против ЛОЖНОЙ ПОЛНОТЫ (контроль-6): список режется на 25, и модель,
    // считая пункты, называла «двадцать пять писем» при 60 в ящике. Молчаливый выброс = ложная полнота.
    if (recognized) {
      return {
        ok: true,
        mail: mail,
        recognized: true,
        unreadTotal: unreadTotal,
        markerConfident: markerConfident,
        truncated: unreadTotal > mail.length,
        rows: rows.length,
        host: location.hostname,
      };
    }
    return {
      ok: true,
      mail: mail,
      recognized: false,
      text: text.replace(/\n{3,}/g, "\n\n").slice(0, 4000),
      textIsWholePage: true,
      host: location.hostname,
    };
  } catch (e) {
    // Сбой разбора — тоже честный фолбэк на текст (иначе владелец не узнает о письмах вообще).
    try {
      const t = (document.body ? document.body.innerText || "" : "").trim();
      if (t) return { ok: true, mail: [], recognized: false, text: t.slice(0, 4000), textIsWholePage: true, parseError: String((e && e.message) || e), host: location.hostname };
    } catch (e2) { /* ниже честная ошибка */ }
    return { ok: false, error: String((e && e.message) || e) };
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
        // §P1-ТЁЗКИ (ревью р1 #10/#15): НОСИТЕЛИ имени = заголовки, где запрос стоит отдельным словом
        // (точно/префикс/по границе). Носителей ≥2 («Катя» и «Катя Любимая») — авто-скорером выбирать
        // НЕЛЬЗЯ (жалоба «не та Катя»): возвращаем ask, как CDP-путь. peer в фолбэк-пути недоступен —
        // модель спросит владельца и повторит точным ПОЛНЫМ именем чата из списка.
        const bearsQ = (title) => {
          const t = lc(title);
          return !!qy && (t === qy || t.startsWith(qy + " ") || t.endsWith(" " + qy) || t.includes(" " + qy + " "));
        };
        const bearers = [...candSet].filter(bearsQ);
        if (bearers.length >= 2) {
          return resolve({
            ok: false,
            step: "namesakes",
            error: "«" + to + "» — ТЁЗКИ, несколько контактов с этим именем: " + bearers.join(" | ") + ". НЕ выбирай сам(а) — СПРОСИ владельца, кому именно, и повтори с ТОЧНЫМ ПОЛНЫМ именем чата из списка.",
            candidates: bearers,
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

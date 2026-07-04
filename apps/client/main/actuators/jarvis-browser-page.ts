/**
 * Инъектируемый в web.telegram (webK) page-side скрипт `window.__tg` (§6) — вынесено из god-file
 * jarvis-browser.ts (§ревью). Чистый browser-JS в `String.raw` (исполняется в КОНТЕКСТЕ СТРАНИЦЫ
 * через CDP Runtime.evaluate), TS-символов не содержит. SRP: page-side логика (общий read/inspect +
 * тюнингованные Telegram-операции по DOM) отдельно от Node-класса JarvisBrowser.
 */
export const PAGE = String.raw`
(() => {
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
    const known = q([".input-search input", "input.input-search-input", "#column-left input.input-field-input", ".sidebar-header input"]);
    if (known) return known;
    const inputs = [...document.querySelectorAll("input")].filter(visible);
    const byHint = inputs.find((el) => { const h = lc(el.placeholder) + " " + lc(el.getAttribute("aria-label")); return h.includes("search") || h.includes("поиск"); });
    if (byHint) return byHint;
    const left = document.querySelector('#column-left, .sidebar-left, [class*="left" i]') || document;
    return [...left.querySelectorAll('input[type="text"], input:not([type]), input.input-field-input')].find(visible) || null;
  };
  const findMsgInput = () => {
    const known = q(['.input-message-input[contenteditable="true"]', "div.input-message-input"]);
    if (known) return known;
    const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
    return eds.find((el) => { const h = lc(el.getAttribute("aria-label")) + " " + lc(el.dataset && el.dataset.placeholder) + " " + lc(el.className); return h.includes("message") || h.includes("сообщен") || h.includes("input-message"); }) || eds[eds.length - 1] || null;
  };
  const loggedIn = () => !(document.body && document.body.classList.contains("has-auth-pages"));
  const hasChatlist = () => Boolean(document.querySelector(".chatlist, ul.chatlist, #folders-container"));
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

  // ── Имя чата как СТРОКА (для кандидатов модели и открытия по точному имени) ──
  // Берём ИМЯ (.peer-title/.user-title), НЕ текст всей строки: иначе в матч попадало бы превью
  // последнего сообщения чужого чата → отправка «левому контакту».
  const rawName = (el) => {
    const tEl = el.querySelector(".peer-title") || el.querySelector(".user-title");
    if (tEl) return (tEl.textContent || "").replace(/\s+/g, " ").trim();
    const sub = el.querySelector('.dialog-subtitle, .row-subtitle, [class*="subtitle" i]');
    let t = el.textContent || "";
    if (sub && sub.textContent) t = t.replace(sub.textContent, "");
    return t.replace(/\s+/g, " ").trim();
  };
  const previewOf = (el) => {
    const sub = el.querySelector('.dialog-subtitle, .row-subtitle, [class*="subtitle" i]');
    return sub ? (sub.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) : "";
  };
  const foldTitle = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const dialogs = () => [...document.querySelectorAll('a.chatlist-chat, li.chatlist-chat, .chatlist-chat, ul.chatlist > a, [class*="chatlist-chat" i]')].filter(visible);
  // peerId Telegram (data-peer-id или href="#<id>"). Знак: + пользователь, − канал/группа (конвенция TG).
  const peerIdOf = (el) => String((el.dataset && el.dataset.peerId) || (el.getAttribute && (el.getAttribute("href") || "").replace("#", "")) || "").trim();
  // МОЙ диалог (раздел «Chats»/недавние), а НЕ глобальный паблик-поиск: «рандом-паблик ко мне не относится».
  const mineOf = (el) => {
    const g = el.closest && el.closest('[class*="search-group" i], section, .sidebar-left-section');
    const h = g && g.querySelector('[class*="title" i], h3, .sidebar-left-section-name');
    const t = lc(h ? h.textContent : "");
    return !/global|глобальн|messages|сообщени/.test(t); // нет группы/«Chats»/недавние → мой; global/messages → нет
  };

  // Saved Messages («Избранное») — ТОЛЬКО через меню (≡), без поиска: поиск слова «Избранное»
  // матчит ЧУЖИЕ каналы с этим словом. Возвращает фокус-инпут + rect.
  const openSavedChat = async () => {
    await sleep(300);
    if (!loggedIn() && !hasChatlist()) { await sleep(2500); if (!loggedIn()) return { ok: false, step: "not-logged-in" }; }
    const mb = await waitForFn(() => q([".sidebar-tools-button", ".btn-menu-toggle.sidebar-tools-button", ".sidebar-header .btn-menu-toggle", "button.btn-menu-toggle"]), 10000);
    if (!mb) return { ok: false, step: "menu-button" };
    realClick(mb); await sleep(800);
    const sm = await waitForFn(() => [...document.querySelectorAll('.btn-menu-item, [class*="menu-item" i]')].filter(visible).find((el) => {
      const t = lc(el.textContent); const ic = lc(el.innerHTML);
      return t.includes("saved") || t.includes("избранн") || ic.includes("savedmessages") || ic.includes("saved-messages");
    }), 6000);
    if (!sm) return { ok: false, step: "saved-menu-item" };
    realClick(sm); await sleep(1800);
    return focusComposer("Saved Messages");
  };

  // Сфокусировать поле сообщения открытого чата → вернуть rect для нативного CDP-клика.
  const focusComposer = async (fallbackTitle) => {
    const input = await waitForFn(findMsgInput, 15000);
    if (!input) return { ok: false, step: "message-input" };
    input.focus();
    const b = input.getBoundingClientRect();
    const ct = (document.querySelector(".chat-info .peer-title, .topbar .peer-title, .chat .user-title") || {}).textContent || fallbackTitle || "";
    return { ok: true, chatTitle: ct, rect: { x: b.x, y: b.y, w: b.width, h: b.height } };
  };

  window.__tg = {
    // читаемый текст текущей страницы (общий read для любого сайта)
    readPage: () => {
      const main = document.querySelector("main, article, [role=main]") || document.body;
      const text = ((main && main.innerText) || "").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 9000);
      // ОБЩИЙ (без хардкода под сайт) сигнал «стена логина»: поле пароля / login-URL / короткий
      // текст с «войти/sign in». Чтобы модель НАДЁЖНО поняла, что нужен web_login, а не гадала.
      const loginWall =
        !!document.querySelector("input[type='password']") ||
        /(?:passport\.|\/login|\/signin|\/sign-in|\/auth(?:\b|orize))/i.test(location.href) ||
        (text.length < 600 && /(?:войд(?:и|ите)|войти|войдите в аккаунт|вход в|sign\s?in|log\s?in|авториз)/i.test(text));
      return { title: document.title || "", url: location.href, text, loginWall };
    },
    // ОБЩИЙ инвентарь интерактивных элементов ЛЮБОГО сайта (глаза модели, как browser_inspect
    // расширения) — устойчивые селекторы без хеш-классов. Это снимает нужду в per-site селекторах:
    // модель видит кнопки/поля/ссылки с их selector/role/aria/text и действует web_act{selector}.
    inspect: (query, cap) => {
      const lim = cap > 0 ? cap : 80;
      const q = String(query || "").toLowerCase();
      const lc = (s) => String(s || "").toLowerCase();
      const SEL =
        'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],' +
        '[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],' +
        '[role="combobox"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"]),[aria-label]';
      const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\\]]/g, "\\$&"));
      const stableId = (id) => id && /^[A-Za-z][\w-]*$/.test(id) && !/\d{4,}/.test(id) && !/[a-f0-9]{8,}/i.test(id);
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
      try { nodes = document.querySelectorAll(SEL); } catch (e) { nodes = []; }
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
        if (out.length >= lim) { truncated = true; break; }
        out.push({
          idx: out.length, tag: el.tagName.toLowerCase(), role, text,
          aria: aria.slice(0, 80) || null, selector: selFor(el),
          disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
          href: el.tagName === "A" ? el.getAttribute("href") : null,
        });
      }
      return { url: location.href, title: document.title || "", count: out.length, truncated, elements: out };
    },
    // СОБРАТЬ кандидатов (RECALL): видимые диалоги + поиск по вариантам (оригинал + транслит,
    // напр. «Герман»,«German»,«Herman»). Решение, кто из них настоящий, принимает МОДЕЛЬ (TS-сторона).
    gatherCandidates: async (to, variants) => {
      await sleep(300);
      if (!loggedIn() && !hasChatlist()) { await sleep(2500); if (!loggedIn()) return { ok: false, step: "not-logged-in" }; }
      const map = new Map();
      const add = (els) => { for (const el of els) { const name = rawName(el); if (!name) continue; const k = foldTitle(name); if (!map.has(k)) map.set(k, { title: name, preview: previewOf(el), peerId: peerIdOf(el), mine: mineOf(el) }); } };
      await waitForFn(() => (dialogs().length ? true : null), 6000);
      add(dialogs()); // уже открытые/недавние чаты
      const search = await waitForFn(findSearch, 8000);
      if (search) {
        const vs = variants && variants.length ? variants : [to];
        for (const v of vs) {
          realClick(search); search.focus(); setInput(search, v);
          await sleep(1500);
          add(dialogs());
        }
      }
      return { ok: true, candidates: [...map.values()].slice(0, 20) };
    },
    // Открыть чат по ТОЧНОМУ имени + (если знаем) peerId. peerId приоритетен (точное попадание даже
    // при одинаковых именах; основа опытной памяти). Возвращает peerId открытого чата (для запоминания).
    openHinted: async (title, peerId) => {
      const want = foldTitle(title);
      const pid = String(peerId || "").trim();
      const search = await waitForFn(findSearch, 8000);
      if (search) { realClick(search); search.focus(); setInput(search, title); await sleep(1800); }
      const pick = () => {
        const all = dialogs();
        return (pid && all.find((el) => peerIdOf(el) === pid)) || all.find((el) => foldTitle(rawName(el)) === want) || all.find((el) => foldTitle(rawName(el)).startsWith(want)) || null;
      };
      let row = await waitForFn(pick, 8000);
      if (!row) return { ok: false, step: "open-by-title" };
      const openedPeer = peerIdOf(row);
      realClick(row); try { row.click(); } catch (e) { /* ignore */ }
      await sleep(2000);
      const fc = await focusComposer(title);
      return fc.ok ? { ...fc, peerId: openedPeer } : fc;
    },
    openSaved: () => openSavedChat(),
    typed: () => { const i = findMsgInput(); return { text: i ? (i.textContent || "").trim() : "" }; },
    verify: (text) => {
      const want = String(text).trim();
      const out = [...document.querySelectorAll('.bubble.is-out, .message.is-out, [class*="bubble" i][class*="is-out" i], .bubbles-group-out .bubble')];
      return { delivered: out.some((b) => (b.textContent || "").includes(want)), outgoingCount: out.length };
    },
    // ЧТЕНИЕ переписки ОТКРЫТОГО чата: последние сообщения с направлением (in/out). Берём ТОЛЬКО
    // .bubble-контейнеры (не вложенные → нет дублей), исключаем служебные/дата-разделители,
    // чистим мета (время/реакции/иконки/edited) клонированием.
    collectMessages: (count) => {
      const clean = (b) => {
        const el = (b.querySelector(".message, .translatable-message") || b).cloneNode(true);
        el.querySelectorAll('.time, [class*="time" i], [class*="reaction" i], [class*="tgico" i], .bubble-content-meta, .message-time, .document-message-meta').forEach((n) => n.remove());
        return (el.textContent || "").replace(/\s+/g, " ").replace(/\s*edited\s*/gi, " ").replace(/(\s*\d{1,2}:\d{2}(\s*(AM|PM))?\s*)+$/i, "").trim();
      };
      const bubbles = [...document.querySelectorAll(".bubble")].filter((b) => visible(b) && !/is-date|service|is-system|fake/.test(b.className));
      const msgs = [];
      for (const b of bubbles) {
        const dir = b.classList.contains("is-out") ? "out" : "in";
        const text = clean(b);
        if (text) msgs.push({ dir, text: text.slice(0, 500) });
      }
      return { ok: true, messages: msgs.slice(-(Number(count) || 12)) };
    },
  };
})();
true;
`;

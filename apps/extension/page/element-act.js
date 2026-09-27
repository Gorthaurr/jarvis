/**
 * Page-функция действия над ЭЛЕМЕНТОМ (ИЗОЛИРОВАННЫЙ мир): ввод, set/select, клавиши, Enter/отправка, прокрутка, seek.
 * Строгая цель (ref | selector | подпись — не нашёл = not_found, в фокус не печатает), §0 secret_field, §14 гард
 * commit_confirm. Вынесено из god-file background.js (W4, п.7) переносом без правки текста функции.
 *
 * ЗАКОН page/*.js: функция САМОДОСТАТОЧНА — в страницу уходит её toString() (executeScript расширения, CDP невидимого
 * браузера клиента); импорты, хелперы и константы уровня модуля в странице не существуют. Только `export function`;
 * сигнатура для TypeScript — в element-act.d.ts.
 */

/**
 * ИЗОЛИРОВАННЫЙ мир расширения (там реестр ref): действие над ЭЛЕМЕНТОМ. Цель — ref из снимка | selector | подпись
 * (P.label; P.text — у интентов, где он не содержимое); без цели type/key/enter/submit идут в фокус страницы.
 * Интенты: type, set (form_input), select, key, enter, submit, scroll_to; по ref — ещё seek и scroll.
 * §0: type/set в СЕКРЕТНОЕ поле (та же isSecret, что в снимке) → secret_field, страница сама не печатает.
 * §14: Enter/отправка формы судится гардом (P.guard) по подписям поля, формы и её кнопки отправки → commit_confirm.
 * submitted:true — Enter реально нажат (жест отправки); форма уходит requestSubmit, только если keydown не отменён.
 * Self-contained (executeScript сериализует функцию).
 */
export async function elementActIsolated(localRef, intent, params) {
  const P = params || {};
  const fail = (code, error) => (code ? { ok: false, code, error } : { ok: false, error });
  const isSecret = (el) =>
    Boolean(el) &&
    el.tagName === "INPUT" &&
    (/^password$/i.test(el.getAttribute("type") || "") ||
      /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[a-z-]+)(?:\s|$)/i.test(el.getAttribute("autocomplete") || ""));
  const SECRET = "secret_field: поле пароля/кода/карты — вводит владелец сам (§0), страница его не заполняет";
  const fold = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[.,!?;:()"'«»\-—–]+/g, " ").replace(/\s+/g, " ").trim();
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
      for (const e of list) out.push(e);
      let all = [];
      try { all = root.querySelectorAll("*"); } catch { /* ignore */ }
      for (const h of all) if (h.shadowRoot) walk(h.shadowRoot);
    };
    walk(document);
    return out;
  };
  const bySelector = (sel) => {
    let scope = document;
    let el = null;
    for (const p of String(sel).split(/\s*>>>\s*/)) {
      try { el = scope.querySelector(p); } catch { return null; }
      if (!el) return null;
      scope = el.shadowRoot || el;
    }
    return el;
  };
  const byIds = (ids) => String(ids || "").split(/\s+/).map((id) => { const nd = id && document.getElementById(id); return nd ? nd.innerText || nd.getAttribute("aria-label") || "" : ""; }).join(" ");
  // Подписи элемента по отдельности (accname-подмножество): поиск по подписи и гард §14 проверяют КАЖДУЮ.
  const labelParts = (e) => {
    const parts = [byIds(e.getAttribute("aria-labelledby")), e.getAttribute("aria-label") || "", e.getAttribute("title") || ""];
    if (e.id) { try { const lab = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (lab) parts.push(lab.innerText || ""); } catch { /* ignore */ } }
    const wrap = e.closest && e.closest("label");
    if (wrap && wrap !== e) parts.push(wrap.innerText || "");
    if (/^(INPUT|TEXTAREA)$/.test(e.tagName)) {
      parts.push(e.getAttribute("placeholder") || "");
      if (/^(submit|button|reset|image)$/i.test(e.type || "")) parts.push(e.value || "", e.getAttribute("alt") || "");
    } else if (e.tagName !== "SELECT") parts.push(String(e.innerText || "")); // без обрезки: одобрение — на ВСЮ подпись
    return parts.map((p) => String(p).replace(/\s+/g, " ").trim()).filter(Boolean);
  };
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scoreText = (q, hay) => {
    if (!q || !hay) return 0;
    if (hay === q) return 100;
    if (new RegExp("(^| )" + escRe(q) + "( |$)").test(hay)) return 80;
    if (q.length > 3 && hay.startsWith(q)) return 60;
    if (q.length >= 4 && hay.includes(q)) return 30;
    return 0;
  };
  const FIELDS = 'input:not([type=hidden]),textarea,select,[contenteditable="true"],[role=textbox],[role=searchbox],[role=combobox],[role=checkbox],[role=radio],[role=switch],[aria-checked]';
  const ANY = FIELDS + ",a,button,summary,label,[role],[tabindex],[aria-label],h1,h2,h3,h4,h5,h6,p,li,dt,dd,td,th";
  // Цель по подписи: лучший балл, при ничьей — самый вложенный (карточка-контейнер не забирает цель у поля).
  const byLabel = (want, sel) => {
    const q = fold(want);
    let best = null;
    let bestScore = 0;
    for (const e of deepAll(sel)) {
      if (!visible(e)) continue;
      const s = Math.max(0, ...labelParts(e).map((p) => scoreText(q, fold(p))));
      if (s > bestScore || (s > 0 && s === bestScore && best && best.contains(e))) { bestScore = s; best = e; }
    }
    return best;
  };
  const editable = (el) =>
    Boolean(el) &&
    (el.isContentEditable ||
      el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && !/^(checkbox|radio|submit|button|reset|image|file|hidden|range|color)$/i.test(el.type || "")));
  const checkable = (el) =>
    Boolean(el) &&
    ((el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type || "")) ||
      /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(el.getAttribute("role") || "") ||
      el.hasAttribute("aria-checked"));
  const active = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a && a !== document.body && a !== document.documentElement ? a : null;
  };

  // ── цель ──
  const textIsContent = intent === "type";
  const optionGiven = P.option != null || P.value != null;
  const want = P.label != null ? String(P.label) : !textIsContent && P.text != null && (intent !== "select" || optionGiven) ? String(P.text) : "";
  let el = null;
  if (localRef) {
    const REG = globalThis.__jarvisRefs;
    if (!REG || !REG.map) return fail("ref_stale", "нет реестра снимка (страница перезагрузилась) — сделай browser_inspect заново");
    const m = /^e(\d+)_/.exec(String(localRef));
    if (!m || Number(m[1]) !== REG.gen) return fail("ref_stale", "ref с прежней страницы (документ сменился) — сделай browser_inspect заново");
    el = REG.map.get(localRef);
    if (!el || !el.isConnected) return fail("ref_stale", "элемент исчез со страницы — сделай browser_inspect заново");
  } else if (P.selector) {
    el = bySelector(String(P.selector));
    if (!el) return fail("not_found", "элемент «" + String(P.selector).slice(0, 80) + "» не найден — сделай browser_inspect");
  } else if (want) {
    el = byLabel(want, intent === "set" || intent === "select" || intent === "type" ? FIELDS : ANY);
    if (!el) return fail("not_found", "не нашёл «" + want.slice(0, 80) + "» — сделай browser_inspect (find)");
  } else if (intent === "type") {
    // Без цели — поле в фокусе, иначе первое видимое поле ввода (прежнее поведение).
    const a = active();
    el = editable(a) && visible(a) ? a : deepAll('input:not([type]),input[type=text],input[type=search],input[type=email],input[type=tel],input[type=url],input[type=number],input[type=password],textarea,[contenteditable="true"]').find((n) => visible(n) && !n.disabled && !n.readOnly) || null;
    if (!el) return fail("not_found", "поле ввода не найдено — укажи ref из browser_inspect");
  } else if (intent === "key" || intent === "enter" || intent === "submit") {
    el = active();
    if (!el || el.tagName === "IFRAME" || el.tagName === "FRAME") {
      if (intent === "key") el = document.body;
      else return fail("not_found", "нет сфокусированного поля для Enter (фокус вне этого документа или отсутствует). Объедини ввод и отправку: browser_act{type, text, enter:true}, либо передай ref поля.");
    }
  } else {
    return fail("not_found", "укажи цель: ref из browser_inspect, selector или text");
  }
  if (el.tagName === "LABEL" && el.control && intent !== "scroll_to") el = el.control;

  // ── клавиши ──
  const NAMED = { enter: ["Enter", 13], return: ["Enter", 13], tab: ["Tab", 9], escape: ["Escape", 27], esc: ["Escape", 27], space: [" ", 32, "Space"], spacebar: [" ", 32, "Space"], backspace: ["Backspace", 8], delete: ["Delete", 46], del: ["Delete", 46], arrowdown: ["ArrowDown", 40], down: ["ArrowDown", 40], arrowup: ["ArrowUp", 38], up: ["ArrowUp", 38], arrowleft: ["ArrowLeft", 37], left: ["ArrowLeft", 37], arrowright: ["ArrowRight", 39], right: ["ArrowRight", 39], home: ["Home", 36], end: ["End", 35], pageup: ["PageUp", 33], pagedown: ["PageDown", 34] };
  // Разбор combo — зеркало parseKeyCombo (@jarvis/shared key-combo.ts), стык — test/fixtures/key-combos.json: ровно ОДНА
  // не-модификаторная клавиша в любом порядке, иначе null → invalid_combo, ничего не жмём («a+Enter» жал голый Enter).
  const MODS = { ctrl: "ctrlKey", control: "ctrlKey", shift: "shiftKey", alt: "altKey", option: "altKey", meta: "metaKey", cmd: "metaKey", command: "metaKey", win: "metaKey", super: "metaKey" };
  const parseCombo = (combo) => {
    const k = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    const keys = [];
    for (const part of String(combo || "").split("+").map((s) => s.trim()).filter(Boolean)) {
      if (MODS[part.toLowerCase()]) k[MODS[part.toLowerCase()]] = true;
      else keys.push(part);
    }
    if (keys.length !== 1) return null;
    const key = keys[0];
    const n = NAMED[key.toLowerCase()];
    if (n) return { ...k, key: n[0], code: n[2] || n[0], keyCode: n[1] };
    if (/^f([1-9]|1[0-2])$/i.test(key)) return { ...k, key: key.toUpperCase(), code: key.toUpperCase(), keyCode: 111 + Number(key.slice(1)) };
    if (key.length !== 1) return null;
    const up = key.toUpperCase();
    return { ...k, key: k.shiftKey ? up : key.toLowerCase(), code: /[a-z]/i.test(key) ? "Key" + up : /\d/.test(key) ? "Digit" + key : "", keyCode: up.charCodeAt(0) };
  };
  const IMPLICIT = /^(text|search|url|tel|email|password|number|date|month|week|time|datetime-local)$/i;
  // Enter в цель: keydown/keypress/keyup; форма — requestSubmit, если страница не отменила клавишу (как у браузера).
  const pressEnter = (t, forceSubmit) => {
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const down = t.dispatchEvent(new KeyboardEvent("keydown", o));
    const press = down ? t.dispatchEvent(new KeyboardEvent("keypress", o)) : false;
    t.dispatchEvent(new KeyboardEvent("keyup", o));
    const form = t.form || (t.closest && t.closest("form"));
    const eligible = forceSubmit || (t.tagName === "INPUT" && IMPLICIT.test(t.type || "text"));
    if (form && down && press && eligible) { try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch { /* невалидная форма */ } }
    return { submitted: true };
  };
  // §14: подпись, узнанная гардом, → commit_confirm с ней (без обрезки). Одобрено (контракт approve), если цель по ref и
  // это одобренный ref, либо сложенная часть подписи РАВНА одобренной (показанная владельцу — тоже часть): не подстрока —
  // одобренное «Отправить» не пропускает «Отправить перевод 50 000 ₽». guardApproved без подписи и ref — не одобрение.
  const judgeParts = (parts) => {
    const shown = P.guard ? parts.find((p) => new RegExp(String(P.guard), "iu").test(p)) : undefined; // битый guard — throw: не жмём
    if (shown === undefined) return null;
    const a = fold(P.approvedLabel);
    const byRef = Boolean(localRef) && P.approvedRef != null && String(P.approvedRef) === String(P.ref);
    if (P.guardApproved && (byRef || (a && parts.some((p) => fold(p) === a)))) return null;
    return { ok: false, code: "commit_confirm", label: shown, error: "commit_confirm: " + shown };
  };
  // Кнопко-подобная цель: Enter/Space её активируют (APG, react-aria) — гард судит её собственные подписи.
  const buttonLike = (e) => Boolean(e && e.matches && e.matches("button,a[href],summary,input[type=submit],input[type=button],input[type=image],input[type=checkbox],input[type=radio],[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=checkbox],[role=switch],[role=radio],[tabindex]"));
  // Enter/отправка — подписи цели (поле или кнопко-подобная; не body), формы и ВСЕХ её кнопок отправки (и вне формы по
  // form=id): requestSubmit без submitter шлёт форму, а первая безобидная «Применить» прятала «Оплатить заказ».
  const guardHit = (t) => {
    const form = t.form || (t.closest && t.closest("form"));
    const subs = form ? [...form.getRootNode().querySelectorAll("button,input")].filter((b) => b.form === form && /^(submit|image)$/i.test(b.type || "")) : [];
    const own = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName) || t.isContentEditable || /^(textbox|searchbox|combobox)$/.test(t.getAttribute("role") || "") || buttonLike(t);
    return judgeParts((own ? labelParts(t) : []).concat(...subs.map(labelParts), form && form.getAttribute("aria-label") ? [form.getAttribute("aria-label")] : []));
  };
  const setNativeValue = (node, val) => {
    const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(node, val);
    else node.value = val;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const readValue = (t) => (t.isContentEditable ? String(t.innerText || "").replace(/ /g, " ") : String(t.value || ""));
  // Запись в поле. Редактор (contenteditable) не разрушаем: выделить содержимое и insertText — его события видит сам
  // редактор (прежний textContent="" сносил разметку и рассинхронизировал модель редактора).
  const writeText = (t, v) => {
    try { t.focus(); } catch { /* ignore */ }
    if (!t.isContentEditable) { setNativeValue(t, v); return null; }
    const sel = getSelection();
    const rg = document.createRange();
    rg.selectNodeContents(t);
    sel.removeAllRanges();
    sel.addRange(rg);
    const done = v ? document.execCommand("insertText", false, v) : document.execCommand("delete");
    const got = fold(readValue(t));
    if (!done || (v && !got.includes(fold(v))) || (!v && got)) return "редактор не принял ввод — сверь browser_inspect (содержимое не заменено)";
    return null;
  };
  const selectOption = (t, wantOpt, parts) => {
    const w = fold(wantOpt);
    if (!w) return fail("", "select: укажи option (или value) — текст варианта из state.options");
    let best = null;
    let bestScore = 0;
    // Текст варианта важнее value (вопрос «на соответствие»: option value=2 с текстом «1»); disabled — мимо.
    for (const o of t.options) {
      if (o.disabled) continue;
      const s = Math.max(scoreText(w, fold(o.text)), String(o.value) === String(wantOpt) ? 90 : 0);
      if (s > bestScore) { bestScore = s; best = o; }
    }
    if (!best) return fail("", "такого варианта в списке нет — варианты в state.options снимка (browser_inspect)");
    // §14 (loop-bypass-7): список, применяющий действие на change («Удалить навсегда») — гард по опции и подписи списка.
    const g = judgeParts([String(best.text || "").replace(/\s+/g, " ").trim()].concat(parts || labelParts(t)).filter(Boolean));
    if (g) return g;
    const before = [...t.selectedOptions];
    try { t.focus(); } catch { /* ignore */ }
    if (t.multiple) best.selected = true;
    else t.selectedIndex = best.index;
    t.dispatchEvent(new Event("input", { bubbles: true }));
    t.dispatchEvent(new Event("change", { bubbles: true }));
    const chosen = [...t.selectedOptions];
    return { ok: chosen.includes(best), value: chosen.map((o) => o.text.trim()).join(", ").slice(0, 60), changed: !before.includes(best) };
  };

  try {
    if (intent === "scroll_to") {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      await new Promise((r) => setTimeout(r, 50));
      const b = el.getBoundingClientRect();
      return { ok: true, inViewport: b.width > 0 && b.height > 0 && b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth };
    }
    if (intent === "scroll") {
      // EXT-9: крутим ближайший прокручиваемый контейнер ЦЕЛИ (список/чат) с цепочкой вверх до окна — как колесо над ней;
      // ни один не сдвинулся (край / не прокручивается) — no_effect, а не ложный ok. 50 мс — и для CSS smooth-прокрутки.
      const moved = async (box) => { const at = () => (box ? box.scrollTop : scrollY); const p0 = at(); (box || window).scrollBy(0, Number(P.dy) || 600); await new Promise((r) => setTimeout(r, 50)); return at() !== p0; };
      for (let s = el; s && s !== document.body && s !== document.documentElement; s = s.parentElement || (s.getRootNode && s.getRootNode().host) || null) {
        if (s.scrollHeight > s.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(s).overflowY) && (await moved(s))) return { ok: true };
      }
      return (await moved(null)) ? { ok: true } : fail("no_effect", "прокрутка ничего не сдвинула — ни контейнер цели, ни страница дальше не прокручиваются (край)");
    }
    if (intent === "seek") {
      // Только медиа САМОЙ цели (она, её плеер-предок или вложенный плеер): чужой первый плеер документа — не цель.
      const md = el.matches && el.matches("audio, video") ? el : (el.querySelector && el.querySelector("audio, video")) || (el.closest && el.closest("audio, video"));
      if (!md) return fail("not_found", "в этом элементе нет видео/аудио для перемотки — укажи ref самого плеера");
      const to = Number(P.to);
      const sec = Number(P.seconds);
      const dur = Number.isFinite(md.duration) ? md.duration : Infinity;
      md.currentTime = Number.isFinite(to) ? Math.min(Math.max(0, to), dur) : Math.min(Math.max(0, md.currentTime + (Number.isFinite(sec) ? sec : 10)), dur);
      return { ok: true, currentTime: Math.round(md.currentTime) };
    }
    if (intent === "type") {
      // Цель — обёртка (форма, карточка поиска): печатаем в её поле. §0 — уже по разрешённому полю.
      if (!editable(el) && el.querySelector) el = el.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]),textarea,[contenteditable="true"]') || el;
      if (isSecret(el)) return fail("secret_field", SECRET);
      if (!editable(el)) return fail("", "элемент не поле ввода — для кнопки click, для галочки/списка set");
      // Флаги нормализует сервер: жест Enter — только строгое true («false»-строка не отправляет).
      const enter = P.enter === true || P.submit === true;
      if (enter) { const g = guardHit(el); if (g) return g; }
      const bad = writeText(el, String(P.text != null ? P.text : ""));
      if (bad) return fail("", bad);
      const out = { ok: true, value: readValue(el).slice(0, 60), submitted: false };
      if (enter) out.submitted = pressEnter(el, P.submit === true).submitted;
      return out;
    }
    if (intent === "set") {
      let t = el;
      if (!checkable(t) && !editable(t) && t.tagName !== "SELECT" && t.querySelector) {
        t = t.querySelector('input[type=checkbox],input[type=radio],[role=checkbox],[role=switch],[role=radio],select,textarea,input:not([type=hidden])') || t;
      }
      // §14 (переключатель/список — тот же гард, что у клика): подписи цели И обёртки, по которой адресовали.
      const own = labelParts(t).concat(t !== el ? labelParts(el) : []);
      if (t.tagName === "SELECT") return selectOption(t, P.value != null ? P.value : P.option, own);
      if (checkable(t)) {
        const b = (v) => (v === true || v === "true" || v === "on" || v === 1 ? true : v === false || v === "false" || v === "off" || v === 0 ? false : undefined);
        const wantOn = b(P.checked !== undefined ? P.checked : P.value);
        if (wantOn === undefined) return fail("", "set для галочки/переключателя: укажи checked:true или false");
        const cur = () => (t.tagName === "INPUT" ? t.checked : t.getAttribute("aria-checked") === "true");
        if (cur() === wantOn) return { ok: true, checked: wantOn, changed: false }; // уже так — не кликаем (повторный set не снимает)
        if (!wantOn && t.tagName === "INPUT" && /^radio$/i.test(t.type)) return fail("", "radio не снимается кликом — выбери другой вариант этой группы");
        if (t.disabled || t.getAttribute("aria-disabled") === "true") return fail("", "элемент недоступен (disabled)");
        const g = judgeParts(own);
        if (g) return g;
        const r = t.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
        for (const ty of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          const C = ty.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
          t.dispatchEvent(new C(ty, o));
        }
        await new Promise((res) => setTimeout(res, 30));
        const now = cur();
        if (now !== wantOn) return fail("", "клик не переключил состояние — сверь browser_inspect");
        return { ok: true, checked: now, changed: true };
      }
      if (editable(t)) {
        if (isSecret(t)) return fail("secret_field", SECRET);
        if (P.value == null) return fail("", "set для поля: укажи value");
        const before = readValue(t);
        const bad = writeText(t, String(P.value));
        if (bad) return fail("", bad);
        const after = readValue(t);
        return { ok: true, value: after.slice(0, 60), changed: after !== before };
      }
      return fail("", "set — для поля, галочки, переключателя или списка; кнопку жми click");
    }
    if (intent === "select") {
      if (el.tagName !== "SELECT") return fail("", "элемент не <select>: у самодельного списка — click по нему, затем по пункту");
      return selectOption(el, P.option != null ? P.option : P.value != null ? P.value : P.text);
    }
    if (intent === "key") {
      const k = parseCombo(P.combo != null ? P.combo : P.key);
      if (!k) return fail("invalid_combo", "key: не понял клавишу «" + String(P.combo != null ? P.combo : P.key || "").slice(0, 30) + "» — одна клавиша плюс модификаторы (Enter, Tab, Escape, ArrowDown, Ctrl+Enter); ничего не нажимал");
      // §14: ЛЮБОЙ Enter (Ctrl/Shift/Alt/Meta+Enter — отправка в чатах) — гард цели и формы; Space активирует кнопку.
      const g = k.key === "Enter" ? guardHit(el) : k.key === " " && buttonLike(el) ? judgeParts(labelParts(el)) : null;
      if (g) return g;
      // Голый Enter — жест браузера (форма уходит); с модификаторами — событие с НАСТОЯЩИМИ модификаторами, без сабмита.
      if (k.key === "Enter" && !k.ctrlKey && !k.altKey && !k.metaKey && !k.shiftKey) return { ok: true, sent: String(P.combo || P.key), ...pressEnter(el, false) };
      const o = { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, altKey: k.altKey, metaKey: k.metaKey, bubbles: true, cancelable: true, composed: true };
      const down = el.dispatchEvent(new KeyboardEvent("keydown", o));
      if (down && k.key.length === 1 && !k.ctrlKey && !k.altKey && !k.metaKey) el.dispatchEvent(new KeyboardEvent("keypress", o));
      el.dispatchEvent(new KeyboardEvent("keyup", o));
      return { ok: true, sent: String(P.combo || P.key), note: "синтетическая клавиша: обработчики страницы её получили, но браузер сам её действие не выполняет (Tab не двигает фокус, символ не печатается)" };
    }
    if (intent === "enter" || intent === "submit") {
      const g = guardHit(el);
      if (g) return g;
      try { el.focus(); } catch { /* ignore */ }
      return { ok: true, ...pressEnter(el, intent === "submit") };
    }
    return fail("", "intent «" + intent + "» не поддержан для элемента");
  } catch (e) {
    return fail("", String((e && e.message) || e));
  }
}

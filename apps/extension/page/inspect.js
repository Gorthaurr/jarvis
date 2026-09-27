/**
 * Page-функция снимка «глаза в DOM» (ИЗОЛИРОВАННЫЙ мир): интерактивные элементы с ref из реестра globalThis.__jarvisRefs
 * (тот же элемент → тот же ref, gen — метка документа), роль, подпись, состояние, устойчивый селектор; query = find с
 * рангом. Вынесено из god-file background.js (W4, п.7) переносом без правки текста функции.
 *
 * ЗАКОН page/*.js: функция САМОДОСТАТОЧНА — в страницу уходит её toString() (executeScript расширения, CDP невидимого
 * браузера клиента); импорты, хелперы и константы уровня модуля в странице не существуют. Только `export function`;
 * сигнатура для TypeScript — в inspect.d.ts.
 */

/**
 * Исполняется ВНУТРИ страницы, в ИЗОЛИРОВАННОМ мире расширения (self-contained — executeScript сериализует функцию,
 * внешние ссылки недоступны). Элемент: {ref, tag, type?, role, name, text?, label?, secret?, state, selector,
 * ambiguous?, href?}; state — value/empty/checked/selected/expanded/pressed/disabled/options.
 * РЕЕСТР ref (globalThis.__jarvisRefs, живёт с документом): тот же элемент → тот же ref между снимками (WeakMap), ref
 * жив, пока жив элемент; gen — метка ДОКУМЕНТА (ref со старой страницы честно протухает, не попадает в тёзку новой).
 * query (find) — ранг по словам запроса и синонимам ролей ru/en, до cap лучших (score — для слияния фреймов).
 */
export function inspectPageInPage(query, cap) {
  cap = cap > 0 ? cap : 80;
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
    '[role="combobox"],[role="textbox"],[role="searchbox"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"]),[aria-label]';
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
  // Селектор годится, только если в своём корне он указывает РОВНО на этот узел. Боевой прогон 26.09 (Moodle): все
  // radio вопроса получали один input[name=…] → клик по «варианту c» попадал в «a»; у галочки перед ней hidden-
  // двойник с тем же name. Неоднозначный якорь → дальше по лестнице (type/value → nth-of-type цепочка).
  const uniqueIn = (node, sel) => {
    try {
      const all = node.getRootNode().querySelectorAll(sel);
      return all.length === 1 && all[0] === node;
    } catch {
      return false;
    }
  };
  const selFor = (node) => {
    const self = anchorFor(node);
    if (self && uniqueIn(node, self)) return self;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) {
      const tag = node.tagName.toLowerCase();
      const type = String(node.getAttribute("type") || "").toLowerCase();
      const typed = tag === "input" && type ? tag + '[type="' + esc(type) + '"]' : tag;
      const nm = node.getAttribute("name");
      if (nm) {
        let s = typed + '[name="' + esc(nm) + '"]';
        if ((type === "radio" || type === "checkbox") && node.hasAttribute("value")) s += '[value="' + esc(node.getAttribute("value")) + '"]';
        if (uniqueIn(node, s)) return s;
      }
      const ph = node.getAttribute("placeholder");
      if (ph && uniqueIn(node, typed + '[placeholder="' + esc(ph) + '"]')) return typed + '[placeholder="' + esc(ph) + '"]';
    }
    const parts = [];
    let n = node;
    let d = 0;
    while (n && n.nodeType === 1 && d < 8) {
      // Якорим цепочку к БЛИЖАЙШЕМУ стабильному И УНИКАЛЬНОМУ предку и обрываем — короткий устойчивый путь.
      // Неуникальный якорь (повторяющиеся id карточек, как #meta на YouTube) уводил все карточки в первую.
      if (n !== node) {
        const a = anchorFor(n);
        if (a && uniqueIn(n, a)) { parts.unshift(a); break; }
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
  // Селектор СКВОЗЬ shadow-границы: «host >>> inner» (act-резолвер понимает эту форму).
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
  // СЕКРЕТНОЕ поле (пароль, одноразовый код, карта): значение не отдаём ни в name, ни в text, ни в state — только
  // «•••». «Показать пароль» делает поле type=text, autocomplete бывает составным («billing cc-number») — судим и
  // по токенам autocomplete. ТА ЖЕ функция стоит в elementActIsolated (§0: туда не печатаем) и в pageActInPage.
  const isSecret = (el) =>
    el.tagName === "INPUT" &&
    (/^password$/i.test(el.getAttribute("type") || "") ||
      /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[a-z-]+)(?:\s|$)/i.test(el.getAttribute("autocomplete") || ""));
  const valueOf = (el) => (isSecret(el) ? (el.value ? "•••" : "") : String(el.value || ""));
  const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n || 80);
  const byIds = (ids) => String(ids || "").split(/\s+/).map((id) => { const nd = id && document.getElementById(id); return nd ? nd.innerText || nd.getAttribute("aria-label") || "" : ""; }).join(" ");
  // Видимая подпись поля: aria-labelledby → <label for> → обёртка <label>.
  const labelOf = (el) => {
    const t = clip(byIds(el.getAttribute("aria-labelledby")));
    if (t) return t;
    if (el.id) { try { const lab = document.querySelector('label[for="' + esc(el.id) + '"]'); if (lab && clip(lab.innerText)) return clip(lab.innerText); } catch { /* ignore */ } }
    const wrap = el.closest && el.closest("label");
    return wrap ? clip(wrap.innerText) : "";
  };
  // accessibleName — прагматичный subset accname-1.2 (aria-labelledby → aria-label → <label> → текст → placeholder/title).
  const axName = (el) => {
    const lb = clip(byIds(el.getAttribute("aria-labelledby")));
    if (lb) return lb;
    const al = clip(el.getAttribute("aria-label"));
    if (al) return al;
    const lab = labelOf(el);
    if (lab) return lab;
    const txt = clip(el.innerText || valueOf(el));
    if (txt) return txt;
    return clip(el.getAttribute("placeholder") || el.getAttribute("title"));
  };
  // СОСТОЯНИЕ: value/[ПУСТО] у полей + checked/selected/expanded/pressed/disabled; у <select> — выбранное и варианты.
  const stateOf = (el) => {
    const st = {};
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if ((/^(INPUT|TEXTAREA)$/.test(tag) && !/^(checkbox|radio|submit|button|reset|image|file|hidden)$/.test(type)) || el.isContentEditable) {
      const v = el.isContentEditable ? el.innerText || "" : el.value || "";
      st.value = isSecret(el) ? (v ? "•••" : "") : v.slice(0, 60);
      if (!v) st.empty = true;
    }
    if (type === "checkbox" || type === "radio") st.checked = Boolean(el.checked);
    if (tag === "SELECT") {
      const opt = el.options[el.selectedIndex];
      st.value = opt ? String(opt.text || "").trim().slice(0, 60) : "";
      st.options = [...el.options].slice(0, 25).map((o) => String(o.text || "").trim().slice(0, 40));
    }
    const ac = el.getAttribute("aria-checked"); if (ac != null) st.checked = ac === "true" ? true : ac === "false" ? false : ac;
    const asel = el.getAttribute("aria-selected"); if (asel != null) st.selected = asel === "true";
    const aexp = el.getAttribute("aria-expanded"); if (aexp != null) st.expanded = aexp === "true";
    const apr = el.getAttribute("aria-pressed"); if (apr != null) st.pressed = apr === "true";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") st.disabled = true;
    return st;
  };
  // Вид элемента для find (синонимы ролей): роль → тег/тип.
  const kindOf = (el) => {
    const r = String(el.getAttribute("role") || "").toLowerCase();
    const R = { searchbox: "textbox", listbox: "combobox", menuitemcheckbox: "checkbox", menuitemradio: "radio" };
    if (/^(button|link|checkbox|radio|switch|tab|menuitem|option|combobox|textbox)$/.test(r)) return r;
    if (R[r]) return R[r];
    const tag = el.tagName;
    const type = String(el.getAttribute("type") || "").toLowerCase();
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "A") return "link";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA" || el.isContentEditable) return "textbox";
    if (tag === "INPUT") {
      if (type === "checkbox" || type === "radio") return type;
      return /^(submit|button|reset|image)$/.test(type) ? "button" : "textbox";
    }
    return "other";
  };
  // SHADOW DOM: querySelectorAll не заглядывает в открытые shadow root'ы — обходим дерево рекурсивно.
  const collectDeep = () => {
    const found = [];
    const walk = (root) => {
      let list = [];
      try { list = root.querySelectorAll(SEL); } catch { /* страховка */ }
      for (const el of list) found.push(el);
      let all = [];
      try { all = root.querySelectorAll("*"); } catch { /* ignore */ }
      for (const h of all) if (h.shadowRoot) walk(h.shadowRoot);
    };
    walk(document);
    return found;
  };
  // Реестр ref документа: старый формат (без rev) пересоздаётся; отсоединённые узлы выметаются на каждом снимке.
  let REG = globalThis.__jarvisRefs;
  if (!REG || !(REG.map instanceof Map) || !REG.rev) {
    REG = globalThis.__jarvisRefs = { gen: 10000 + Math.floor(Math.random() * 90000), map: new Map(), rev: new WeakMap(), next: 0 };
  }
  for (const [k, v] of REG.map) if (!v || !v.isConnected) REG.map.delete(k);
  const refFor = (el) => {
    const old = REG.rev.get(el);
    if (old && REG.map.get(old) === el) return old;
    const ref = "e" + REG.gen + "_" + REG.next++;
    REG.map.set(ref, el);
    REG.rev.set(el, ref);
    return ref;
  };
  // find: токены запроса (свёртка регистра/ё/пунктуации), слова ролей → вид элемента, прочее — по подписи.
  const fold = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const ROLE_WORDS = [
    [/^(кнопк\p{L}*|button|btn)$/u, ["button"]],
    [/^(пол[еяюи]|input|textbox|textarea|field|инпут\p{L}*|ввод\p{L}*|строк\p{L}*)$/u, ["textbox"]],
    [/^(галочк\p{L}*|чекбокс\p{L}*|checkbox|флаж\p{L}*|флажок)$/u, ["checkbox"]],
    [/^(переключател\p{L}*|radio|радио\p{L}*)$/u, ["radio", "switch"]],
    [/^(тумблер\p{L}*|switch|toggle)$/u, ["switch", "checkbox"]],
    [/^(ссылк\p{L}*|link)$/u, ["link"]],
    [/^(список|списк\p{L}*|select|combobox|dropdown|выпадающ\p{L}*)$/u, ["combobox"]],
    [/^(вкладк\p{L}*|tab)$/u, ["tab"]],
    [/^(меню|menuitem|пункт\p{L}*|option)$/u, ["menuitem", "option"]],
    [/^(вариант\p{L}*)$/u, ["radio", "option", "checkbox"]],
  ];
  const STOP = new Set(["на", "в", "во", "для", "по", "с", "со", "к", "и", "или", "the", "a", "an", "to", "of", "for", "on", "in", "with"]);
  const qTok = fold(query).split(" ").filter((t) => t && !STOP.has(t));
  const kinds = new Set();
  const words = [];
  for (const t of qTok) {
    const hit = ROLE_WORDS.find(([re]) => re.test(t));
    if (hit) hit[1].forEach((k) => kinds.add(k));
    else words.push(t);
  }
  const prefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1; return i; };
  const scoreOf = (hay, name, kind) => {
    const ws = hay.split(" ").filter(Boolean);
    let s = 0;
    let hits = 0;
    for (const t of words) {
      let w = 0;
      if (ws.includes(t)) w = 3;
      else if (t.length >= 3 && ws.some((x) => x.startsWith(t) || (x.length >= 3 && t.startsWith(x)))) w = 2;
      else if (t.length >= 5 && ws.some((x) => prefix(x, t) >= Math.max(4, Math.min(x.length, t.length) - 2))) w = 1.5; // словоформа
      else if (t.length >= 4 && hay.includes(t)) w = 1;
      if (w) hits += 1;
      s += w;
    }
    if (words.length && !hits) return 0;
    if (words.length && hits === words.length) s += 2;
    if (words.length && fold(name) === words.join(" ")) s += 3;
    if (kinds.size) {
      if (kinds.has(kind)) s += 2;
      else if (!words.length) return 0;
      else s -= 1;
    }
    return s > 0 ? s : 0;
  };
  const finding = qTok.length > 0;
  const seen = new Set();
  const cands = [];
  let truncated = false;
  for (const el of collectDeep()) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!visible(el)) continue;
    // Снимок без query — выходим на капе (подпись/innerText каждого узла дорогие: сотни на ленте). find ранжирует всё.
    if (!finding && cands.length >= cap) { truncated = true; break; }
    const name = axName(el);
    const isField = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    const text = isField ? "" : clip(el.innerText || el.getAttribute("title"));
    const label = isField || /^(radio|checkbox|switch|combobox|textbox)$/.test(el.getAttribute("role") || "") ? labelOf(el) : "";
    const kind = kindOf(el);
    let score = 0;
    if (finding) {
      const hay = fold([name, text, label, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("title"), isField && !isSecret(el) && el.type !== "hidden" ? el.value : ""].join(" "));
      score = scoreOf(hay, name, kind);
      if (!score) continue;
    }
    cands.push({ el, name, text, label, score });
  }
  if (finding) cands.sort((a, b) => b.score - a.score); // стабильная сортировка: при равенстве — порядок документа
  if (cands.length > cap) truncated = true;
  const out = [];
  for (const c of cands.slice(0, cap)) {
    const el = c.el;
    const selector = selForDeep(el);
    const type = el.tagName === "INPUT" ? String(el.getAttribute("type") || "text").toLowerCase() : "";
    const href = el.tagName === "A" ? el.getAttribute("href") : null;
    out.push({
      ref: refFor(el),
      tag: el.tagName.toLowerCase(),
      ...(type ? { type } : {}),
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name: c.name || null,
      ...(c.text && c.text !== c.name ? { text: c.text } : {}),
      ...(c.label && c.label !== c.name ? { label: c.label } : {}),
      ...(isSecret(el) ? { secret: true } : {}),
      state: stateOf(el),
      selector,
      // Селектор без shadow-звеньев, который бьёт не только в этот узел, — честно помечаем: клик по нему попадёт в первый.
      ...(!selector.includes(">>>") && !uniqueIn(el, selector) ? { ambiguous: true } : {}),
      ...(href ? { href } : {}),
      ...(finding ? { score: c.score } : {}),
    });
  }
  return { url: location.href, title: document.title || "", count: out.length, truncated, gen: REG.gen, elements: out };
}

/**
 * Page-функция клика (MAIN-мир, видит React-props страницы): цель по nonce ref | selector | тексту со скорингом (не
 * голый .includes), указатель первым, §14 гард commit_confirm на подписи цели, наблюдатель «страница отреагировала».
 * Вынесено из god-file background.js (W4, п.7) переносом без правки текста функции.
 *
 * ЗАКОН page/*.js: функция САМОДОСТАТОЧНА — в страницу уходит её toString() (executeScript расширения, CDP невидимого
 * браузера клиента); импорты, хелперы и константы уровня модуля в странице не существуют. Только `export function`;
 * сигнатура для TypeScript — в robust-click.d.ts.
 */

/**
 * Исполняется в MAIN-world (видит React-props страницы). Клик по цели (ref через nonce | selector | текст):
 * указатель первым; React-onClick самой цели — только если клик до неё не дошёл (Swiper-гейт в capture-фазе); Enter —
 * только во встряхивании (expectChange сверяет реальную смену). changed — наблюдатель изменений всего документа.
 * P.action:"hover" (ставит SW) — навести указатель, без гарда. Функция статична → CSP-safe.
 */
export async function robustClickMain(params) {
  const P = params || {};
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
  // Боевой прогон 26.09 (Moodle): подпись radio/checkbox живёт вне элемента — aria-labelledby / label[for] /
  // обёртка <label>; у кнопки-input текст в value (в innerText его нет). Без этого «выбери Париж» и
  // «Следующая страница» не находились вовсе.
  // Источники подписи элемента — по отдельности (accname-подмножество, как axName в inspect): для поиска их
  // склеиваем, а гард §14 проверяет КАЖДЫЙ (якорные слова LMS «^сохранить$» не должны ломаться о склейку с title).
  const labelParts = (e) => {
    const tag = e.tagName;
    const type = String(e.getAttribute("type") || "").toLowerCase();
    const parts = [];
    const byIds = (ids) => String(ids || "").split(/\s+/).map((id) => { const nd = id && document.getElementById(id); return nd ? nd.innerText || nd.getAttribute("aria-label") || "" : ""; }).join(" ");
    parts.push(byIds(e.getAttribute("aria-labelledby")), e.getAttribute("aria-label") || "", e.title || "");
    if (tag === "INPUT" && /^(submit|button|reset|image)$/.test(type)) parts.push(e.value || "", e.getAttribute("alt") || "");
    else if (tag === "INPUT" && (type === "radio" || type === "checkbox")) {
      if (e.id) { try { const lab = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (lab) parts.push(lab.innerText || ""); } catch { /* ignore */ } }
      const wrap = e.closest && e.closest("label");
      if (wrap) parts.push(wrap.innerText || "");
    } else if (tag !== "INPUT") {
      parts.push(e.innerText || "");
      // Кнопка-иконка: подпись в alt картинки или <title> внутри svg.
      for (const im of e.querySelectorAll ? e.querySelectorAll("img[alt], svg title") : []) parts.push(im.getAttribute("alt") || im.textContent || "");
    }
    return parts.map((p) => String(p).replace(/\s+/g, " ").trim()).filter(Boolean);
  };
  const nameOf = (e) => labelParts(e).join(" ");
  // МОДАЛЬНОЕ окно — единственное, что доступно живой руке: одноимённая кнопка страницы под затемнением проигрывает
  // кнопке окна (Moodle «Отправить всё и завершить тест»; core/modal ставит aria-modal="true"). Немодальный
  // role=dialog (cookie-баннер, выдвижное меню за экраном) бонуса НЕ получает — иначе забирал клик у страницы.
  const inOpenDialog = (e) => {
    let d = null;
    try { d = e.closest && (e.closest('[aria-modal="true"]') || e.closest("dialog:modal")); } catch { d = e.closest && e.closest('[aria-modal="true"]'); }
    if (!d || !visible(d)) return false;
    const b = e.getBoundingClientRect();
    return b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight;
  };
  const covered = (e) => {
    if (e.getRootNode && e.getRootNode() !== document) return false;
    const b = e.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit) && hit !== e && !e.contains(hit) && !hit.contains(e);
  };
  const CAND =
    "a,button,input[type=submit],input[type=button],input[type=reset],input[type=image],input[type=radio],input[type=checkbox]," +
    "summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=radio],[role=checkbox],[aria-label],[data-test-id],[tabindex]";
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
    // Наведение цепляет и пункты меню-li, картинки, заголовки (меню часто раскрывается по mouseenter). div/span не берём:
    // подпись каждого — innerText, на большой странице это секунды блокировки. Их цель — по ref из browser_inspect.
    for (const e of deepAll(P.action === "hover" ? CAND + ",li,img,td,th,h1,h2,h3,h4,h5,h6" : CAND)) {
      // isConnected вместо document.contains: contains НЕ пересекает shadow-границу (ложно отсекал бы shadow-элементы)
      if (!e.isConnected) continue;
      if (e.closest && e.closest(".swiper-slide-duplicate")) continue;
      if (!visible(e)) continue;
      let s = scoreText(q, foldTxt(nameOf(e)));
      if (s > 0) s += (inOpenDialog(e) ? 5 : 0) - (covered(e) ? 15 : 0);
      // Ничья → самый ВЛОЖЕННЫЙ: карточка [tabindex] с тем же текстом, что у галочки внутри, забирала клик себе.
      if (s > bestScore || (s > 0 && s === bestScore && best && best.contains(e))) { bestScore = s; best = e; }
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
  // Нативный элемент кликаем САМ (radio/label/input-кнопка): подъём к [tabindex]-предку уводил клик в контейнер.
  const NATIVE = "a[href],area[href],button,input,select,textarea,summary,label,option";
  const isNative = (el) => Boolean(el && el.matches && el.matches(NATIVE));
  const target = isNative(node) ? node : (node.closest && node.closest("button,[role=button],a,[role=link],[tabindex]")) || node;
  // §14 на СТРАНИЦЕ (26.09): сервер не видит подписи элемента, выбранного селектором/ref, а браузер видит. На
  // опасном сайте/LMS сервер присылает guard (регэксп глаголов коммита) — подпись совпала и одобрения нет →
  // НЕ кликаем, возвращаем подпись: сервер спросит владельца и повторит с guardApproved (флаг ставит только он).
  if (P.guard && P.action !== "hover") {
    // Enter-фолбэк — жест отправки формы: судим и все её кнопки отправки, как guardHit.
    const form = P.expectChange && (target.form || (target.closest && target.closest("form")));
    const subs = form ? [...form.getRootNode().querySelectorAll("button,input")].filter((b) => b.form === form && /^(submit|image)$/i.test(b.type || "")) : [];
    const parts = labelParts(target).concat(target !== node ? labelParts(node) : [], ...subs.map(labelParts));
    const shown = parts.find((p) => new RegExp(String(P.guard), "iu").test(p)); // битый guard — throw: клика нет
    // Одобрение (контракт approve): тот же ref, либо сложенная часть подписи РАВНА одобренной (не подстрока, без обрезки)
    // — пока владелец думал, страница могла перерисоваться («Оплатить 50 000 ₽» вместо одобренного «Отправить»).
    const a = foldTxt(P.approvedLabel);
    const byRef = Boolean(P.nonce) && P.approvedRef != null && String(P.approvedRef) === String(P.ref);
    if (shown !== undefined && !(P.guardApproved && (byRef || (a && parts.some((p) => foldTxt(p) === a))))) {
      return { ok: false, code: "commit_confirm", label: shown, error: "commit_confirm: " + shown };
    }
  }
  try {
    target.scrollIntoView({ block: "center" });
  } catch {
    /* ignore */
  }
  // B-7: «страница отреагировала» — MutationObserver по ВСЕМУ документу за окно действия + смена URL, числа видимых
  // диалогов и состояния цели. Шум не считается: узлы, менявшиеся САМИ за 150 мс до действия, медиа/таймеры/прогресс,
  // время вида 12:34. Цифры не вырезаются («Товаров 1→2» — изменение), портал вне main виден.
  const NOISY = "video,audio,progress,meter,[role=timer],[role=progressbar],[role=marquee],[role=slider]";
  const TIME = /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/;
  const MUT = { subtree: true, childList: true, characterData: true, attributes: true };
  const elOf = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
  const noisy = new WeakSet();
  const markNoisy = (recs) => { for (const rec of recs) { const e = elOf(rec.target); if (e) noisy.add(e); } };
  const pre = new MutationObserver(markNoisy); // записи приходят в колбэк — takeRecords отдаёт лишь хвост
  pre.observe(document, MUT);
  await new Promise((r) => setTimeout(r, 150));
  markNoisy(pre.takeRecords());
  pre.disconnect();
  const quiet = (e) => !e || (e.closest && e.closest(NOISY)) || TIME.test(e.textContent || "");
  let changes = 0;
  const count = (recs) => {
    for (const rec of recs) {
      const e = elOf(rec.target);
      if (rec.type === "attributes") {
        if (rec.attributeName !== "data-jarvis-act" && !noisy.has(e) && !quiet(e)) changes += 1;
      } else if (rec.type === "characterData") {
        if (!noisy.has(e) && !quiet(e) && !TIME.test(rec.target.data || "")) changes += 1;
      } else {
        // Шумный контейнер (карусель, бегущая строка) не считается; исключение — body: туда рисуют порталы (модалки),
        // а скрипты рекламы, из-за которых body «шумит», добавляют невидимые узлы.
        const moved = [...rec.addedNodes, ...rec.removedNodes].some((n) => (n.nodeType === 1 || (n.nodeType === 3 && n.data.trim())) && !TIME.test(n.textContent || ""));
        const portal = e === document.body && [...rec.addedNodes].some((n) => n.nodeType === 1 && n.isConnected && !quiet(n) && n.getClientRects().length > 0);
        if (portal || (moved && !noisy.has(e) && !quiet(e))) changes += 1;
      }
    }
  };
  const obs = new MutationObserver(count);
  obs.observe(document, MUT);
  const dialogs = () => [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal="true"]')].filter(visible).length;
  const stateOf = (n) => [n.checked, n.value, n.getAttribute("aria-checked"), n.getAttribute("aria-expanded"), n.getAttribute("aria-pressed")].join("|");
  const dlgBefore = dialogs();
  const stBefore = stateOf(target);
  // SPA-роутинг (pushState) не убивает контекст → переход виден по location.href (navigated = readback, сервер снимет долг).
  // Жёсткий переход (27.09, Moodle «Вход») уводит документ в bfcache ЗАМОРОЖЕННЫМ: таймер ожидания не сработает, executeScript
  // молчал бы минутами (мост: isError через 20 с) → ожидание после жеста — наперегонки с pagehide; ушли → маркер pageLeft.
  const hrefBefore = location.href;
  const changedNow = () => {
    count(obs.takeRecords());
    return changes > 0 || location.href !== hrefBefore || dialogs() !== dlgBefore || stateOf(target) !== stBefore;
  };
  const finish = (res) => {
    obs.disconnect();
    if (location.href !== hrefBefore) res.navigated = location.href;
    return res;
  };
  // true — дождались на месте; false — документ ушёл (синтетический pagehide страницы — не уход: только isTrusted).
  const settle = (ms) => new Promise((r) => { const h = (e) => e.isTrusted && r(false); addEventListener("pagehide", h); setTimeout(() => { removeEventListener("pagehide", h); r(true); }, ms); });
  // Маркер, не исход: куда ушла вкладка и чей это уход (вкладки или фрейма) — решает SW (modules/page-left.js).
  const left = () => { obs.disconnect(); return { ok: true, pageLeft: true, navigated: true, uncertain: true, note: "страница ушла во время действия — исход не подтверждён" }; };
  const r0 = target.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2, button: 0 };
  const fire = (el, ty, o) => {
    try {
      const C = ty.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      return el.dispatchEvent(new C(ty, o));
    } catch {
      return false;
    }
  };

  // HOVER: навести указатель (меню/подсказки по наведению). mouseenter не всплывает — шлём цели и её предкам, как
  // настоящий указатель, входящий в каждый из них. Без гарда: наведение ничего не совершает.
  if (P.action === "hover") {
    fire(target, "pointerover", at);
    fire(target, "mouseover", at);
    for (let n = target; n && n !== document.documentElement; n = n.parentElement) {
      fire(n, "pointerenter", { ...at, bubbles: false });
      fire(n, "mouseenter", { ...at, bubbles: false });
    }
    fire(target, "pointermove", at);
    fire(target, "mousemove", at);
    if (!(await settle(400))) return left();
    return finish({ ok: true, method: "hover", changed: changedNow() });
  }

  // B-1: указатель ПЕРВЫМ — ровно один click (синтетический click сам запускает активацию: ссылку, сабмит, галочку;
  // react-router Link сам сделает preventDefault и переход). Слушатель capture+once на САМОЙ цели узнаёт, дошёл ли клик
  // до неё: не дошёл (Swiper-гейт в capture-фазе предка глушит синтетику) → зовём React-onClick САМОГО элемента
  // (не предка!) событием с button:0. Прежний подъём по предкам звал onClick обёртки фейком без button — ссылка
  // внутри не переходила, Link молча выходил, а ответ был ok.
  let reached = false;
  const pointer = () => {
    const mark = () => { reached = true; };
    target.addEventListener("click", mark, { capture: true, once: true });
    for (const ty of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) fire(target, ty, at);
    target.removeEventListener("click", mark, { capture: true }); // once не снимет, если клик не дошёл
    return true;
  };
  const reactOwn = () => {
    if (reached) return false; // клик уже дошёл до цели — второй вызов onClick был бы двойным действием
    const key = Object.keys(target).find((k) => k.startsWith("__reactProps$"));
    const props = key && target[key];
    if (!props || typeof props.onClick !== "function") return false;
    let prevented = false;
    const ev = {
      type: "click", button: 0, buttons: 0, detail: 1, bubbles: true, cancelable: true, target, currentTarget: target,
      clientX: at.clientX, clientY: at.clientY, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      defaultPrevented: false, nativeEvent: { type: "click", button: 0 },
      isDefaultPrevented: () => prevented, isPropagationStopped: () => false, persist() {},
      preventDefault() { prevented = true; this.defaultPrevented = true; }, stopPropagation() {},
    };
    props.onClick(ev);
    return true;
  };
  const pressEnter = () => {
    try { target.focus(); } catch { /* ignore */ }
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", o));
    target.dispatchEvent(new KeyboardEvent("keyup", o));
    return true;
  };
  // H19: синтетический Enter не жмёт нативную кнопку/ссылку — он только во встряхивании (expectChange сверяет
  // РЕАЛЬНУЮ смену контента после каждого метода). В поле ввода — никогда: Enter в композер = отправка (srv-bypass-5).
  const methods = [{ name: "pointer", fn: pointer }, { name: "react", fn: reactOwn }];
  if (P.expectChange && !target.isContentEditable && !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) methods.push({ name: "enter", fn: pressEnter });
  let used = null;
  for (const m of methods) {
    let fired = false;
    try { fired = m.fn(); } catch { fired = false; }
    if (!fired) continue;
    used = m.name;
    if (P.expectChange) {
      if (!(await settle(700))) return left();
      if (changedNow()) return finish({ ok: true, method: m.name, changed: true });
    } else if (m.name === "react" || reached) {
      break; // клик дошёл до цели (или его сделал React-проп) — ждём реакцию страницы
    }
  }
  if (P.expectChange) {
    obs.disconnect();
    // no_effect: элемент НАЙДЕН и клик отработал, но контент не сменился — probe iframe НЕ запускаем (иначе клик
    // задублируется в другом документе). Честный провал в top.
    return { ok: false, code: "no_effect", error: "действие не дало эффекта: клик, React-onClick и Enter не изменили страницу (возможно, кнопка не та или она неактивна)" };
  }
  // Клик до цели не дошёл и React-пропа у неё нет: ответ ok (жест сделан), но changed скажет правду.
  if (!(await settle(500))) return left();
  return finish({ ok: true, method: used || "pointer", ...(reached || used === "react" ? {} : { reached: false }), changed: changedNow() });
}

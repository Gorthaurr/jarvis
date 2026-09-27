/**
 * Page-функция поиска цели в ДОЧЕРНЕМ фрейме (без действия): есть ли тут selector / текст (сильный матч, score ≥ 80) /
 * крупное видимое медиа. Top-фрейм отвечает сразу (там уже искали). Вынесено из god-file background.js (W4, п.7)
 * переносом без правки текста функции.
 *
 * ЗАКОН page/*.js: функция САМОДОСТАТОЧНА — в страницу уходит её toString() (executeScript расширения, CDP невидимого
 * браузера клиента); импорты, хелперы и константы уровня модуля в странице не существуют. Только `export function`;
 * сигнатура для TypeScript — в probe.d.ts.
 */

/**
 * Исполняется ВНУТРИ фрейма (self-contained): есть ли тут цель и НАСКОЛЬКО уверенно (score)? spec:
 * {selector} | {text} | {media:true} (ввод без selector фреймы не щупает — «любое поле» чужого виджета не цель). Матч текста зеркалит byText из pageActInPage
 * (fold+скоринг), порог сильный (целое слово/точное — score≥80), чтобы probe не тащил слабый substring
 * из рекламы (ревью #5). media — только ВИДИМЫЙ и КРУПНЫЙ элемент (muted-autoplay трекер отсеян, ревью #2).
 * Shadow DOM обходится, селектор понимает « >>> ». Возвращает {found, score, url}.
 */
export function probeFindInPage(spec) {
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

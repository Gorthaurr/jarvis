/**
 * Page-функция чтения (ИЗОЛИРОВАННЫЙ мир, каждый фрейм при allFrames): читаемый текст области main (открытые окна —
 * первыми), заголовки h1-h3, фильтр строк по query, медиа-состояние крупнейшего плеера, исходный TeX формул. Вынесено
 * из god-file background.js (W4, п.7) переносом без правки текста функции.
 *
 * ЗАКОН page/*.js: функция САМОДОСТАТОЧНА — в страницу уходит её toString() (executeScript расширения, CDP невидимого
 * браузера клиента); импорты, хелперы и константы уровня модуля в странице не существуют. Только `export function`;
 * сигнатура для TypeScript — в read.d.ts.
 */

/**
 * Исполняется ВНУТРИ страницы (и каждого iframe при allFrames): читаемый текст + структура (h1-h3).
 * query — ключевые слова: остаются ТОЛЬКО строки-совпадения с контекстом ±1 (страница целиком не влезает
 * в кап — раньше «current track title» получал хвост шапки, а не нужный блок). Пустой query или ноль
 * совпадений → общий дамп (filtered:false — сервер честно скажет «фильтр не выделил»).
 */
export function readPageInPage(query) {
  const fold = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");
  // B-8: область чтения — main / [role=main], иначе body. Первая <article> брала из ленты один пост. Открытые окна
  // (dialog, role=dialog/alertdialog, aria-modal) — ПЕРВЫМИ: модалка важнее фона под ней, а портал в конце body
  // иначе срезался бы капом (и вне main не виден вовсе).
  const main = document.querySelector("main, [role=main]") || document.body;
  const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const windows = [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal="true"]')]
    .filter((d, i, all) => shown(d) && !all.some((o) => o !== d && o.contains(d)))
    .slice(0, 3)
    .map((d) => "[Окно] " + String(d.innerText || "").trim().slice(0, 2000))
    .filter((t) => t.length > 7);
  const body = ((main && main.innerText) || "").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const raw = (windows.length ? windows.join("\n\n") + "\n\n" : "") + body;
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
  // Формулы (26.09, тесты Moodle): innerText отдаёт отрисованные глифы MathJax кашей («ab» вместо a/b), а исходный
  // TeX лежит рядом — <script type="math/tex"> (MathJax 2), alt у картинок фильтра TeX, alttext у <math>. Отдаём его
  // приложением к тексту, чтобы модель решала задачу по формуле, а не по обломкам вёрстки.
  const tex = [];
  const scope = main || document;
  for (const s of scope.querySelectorAll('script[type^="math/tex"]')) { const t = (s.textContent || "").trim(); if (t) tex.push(t); }
  for (const im of scope.querySelectorAll("img.texrender[alt]")) { const t = (im.getAttribute("alt") || "").trim(); if (t) tex.push(t); }
  for (const m of scope.querySelectorAll("math[alttext]")) { const t = (m.getAttribute("alttext") || "").trim(); if (t) tex.push(t); }
  // В НАЧАЛО текста и с потолком: хвост режут и расширение (8000), и сервер (шапка title/URL/разделы + cutText) — в
  // конце формулы терялись без сигнала или рвались посреди TeX (ревью 26.09).
  let formulas = "";
  for (const [i, t] of tex.entries()) {
    const item = (i ? "; " : "") + (i + 1) + ") " + t.slice(0, 200);
    if (formulas.length + item.length > 1800) { formulas += "; …(ещё " + (tex.length - i) + ")"; break; }
    formulas += item;
  }
  const prefix = formulas ? "[Формулы на странице — исходный TeX по порядку: " + formulas + "]\n\n" : "";
  return { title: document.title || "", url: location.href, text: (prefix + text).slice(0, 8000), headings, filtered, ...(media ? { media } : {}) };
}

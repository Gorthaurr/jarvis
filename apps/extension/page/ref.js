/**
 * Page-функции реестра ref (ИЗОЛИРОВАННЫЙ мир, там живёт globalThis.__jarvisRefs): пометка элемента для клика в MAIN,
 * прямоугольник цели для снимка вкладки, медиа-состояние, пред-валидация ref батча. Вынесено из god-file background.js
 * (W4, п.7) переносом без правки текста функций.
 *
 * ЗАКОН page/*.js: каждая функция САМОДОСТАТОЧНА. chrome.scripting.executeScript (расширение) и невидимый браузер
 * клиента (CDP) исполняют в странице её toString() — импортов, хелперов и констант уровня модуля там НЕТ
 * (ReferenceError в странице; стенд apps/extension/test исполняет эти функции в настоящем Chromium). В файле — только
 * `export function`; сигнатуры для TypeScript — в соседнем .d.ts.
 */

/**
 * ISOLATED-world: пометить элемент из ref-реестра эфемерным nonce-атрибутом (мост в MAIN для React-клика).
 * Резолв по ИДЕНТИЧНОСТИ + сверка gen/isConnected → устаревший ref = честный ref_stale, НЕ слепой хит.
 * Self-contained (инжектится, без внешних ссылок).
 */
export function stampRefIsolated(localRef, nonce) {
  const REG = globalThis.__jarvisRefs;
  if (!REG || !REG.map) return { ok: false, code: "ref_stale", error: "нет реестра снимка (страница перезагрузилась) — сделай browser_inspect заново" };
  const m = /^e(\d+)_/.exec(String(localRef));
  const gen = m ? Number(m[1]) : -1;
  if (REG.gen !== gen) return { ok: false, code: "ref_stale", error: "ref_stale: ref с прежней страницы (документ сменился) — сделай browser_inspect заново" };
  const el = REG.map.get(localRef);
  if (!el || !el.isConnected) return { ok: false, code: "ref_stale", error: "элемент исчез со страницы — сделай browser_inspect заново" };
  try { el.setAttribute("data-jarvis-act", String(nonce)); } catch { return { ok: false, error: "не смог пометить элемент для клика" }; }
  return { ok: true };
}

/**
 * ИЗОЛИРОВАННЫЙ мир (там реестр ref): размеры вьюпорта и — по ref — прямоугольник элемента в CSS px для снимка вкладки
 * (tab.capture). Элемент вне экрана прокручивается в центр и ждёт кадр, чтобы снимок видел его на месте. Self-contained.
 */
export async function captureTargetIsolated(localRef) {
  const vp = { ok: true, w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 };
  if (!localRef) return vp;
  const REG = globalThis.__jarvisRefs;
  if (!REG || !REG.map) return { ok: false, code: "ref_stale", error: "нет реестра снимка (страница перезагрузилась) — сделай browser_inspect заново" };
  const m = /^e(\d+)_/.exec(String(localRef));
  if (!m || Number(m[1]) !== REG.gen) return { ok: false, code: "ref_stale", error: "ref с прежней страницы (документ сменился) — сделай browser_inspect заново" };
  const el = REG.map.get(localRef);
  if (!el || !el.isConnected) return { ok: false, code: "ref_stale", error: "элемент исчез со страницы — сделай browser_inspect заново" };
  let r = el.getBoundingClientRect();
  if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
    el.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((res) => { const t = setTimeout(res, 150); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); res(); })); });
    r = el.getBoundingClientRect();
  }
  if (r.width < 1 || r.height < 1) return { ok: false, code: "capture_failed", error: "элемент без размера (скрыт) — снимать нечего" };
  return { ...vp, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
}

/** ISOLATED-world: состояние медиа (ground-truth play/pause). Self-contained. */
export function readMediaStateIsolated() {
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
export function validateRefsIsolated(localRefs) {
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

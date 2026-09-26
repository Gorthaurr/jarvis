/**
 * Арифметика снимка вкладки (tab.capture, контракт W1 §1) — чистые функции без chrome/DOM, тест в node.
 * Снимок captureVisibleTab — в ФИЗИЧЕСКИХ пикселях (CSS × devicePixelRatio); rect/ref приходят в CSS px вьюпорта.
 * Потолок картинки для модели: ≤ 1568 по длинной стороне и ≤ 1,15 Мп (больше зрение всё равно ужмёт, а токены съест).
 */
export const MAX_SIDE = 1568;
export const MAX_PIXELS = 1_150_000;

/** Размер PNG из data:-URL по заголовку IHDR (ширина/высота — big-endian на байтах 16..23). Не PNG → null. */
export function pngSize(dataUrl) {
  const m = /^data:image\/png;base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!m) return null;
  const head = atob(m[1].slice(0, 44));
  if (head.slice(1, 4) !== "PNG") return null;
  const u32 = (o) => ((head.charCodeAt(o) << 24) | (head.charCodeAt(o + 1) << 16) | (head.charCodeAt(o + 2) << 8) | head.charCodeAt(o + 3)) >>> 0;
  return { width: u32(16), height: u32(20) };
}

/** Во сколько раз можно увеличить (или надо уменьшить) картинку w×h, не выходя за потолок. */
function capFactor(w, h) {
  return Math.min(MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
}

/**
 * План снимка: какой кусок снимка (sx, sy, sw, sh — физические px) и в каком размере (outW×outH) отдать.
 * Без rect — весь вьюпорт, только ужатый до потолка. С rect — кроп (обрезанный по вьюпорту), масштаб `scale`
 * (деф: вписать в 1568 по длинной стороне, но не больше ×2), в любом случае не выше потолка.
 * Возвращает {sx, sy, sw, sh, outW, outH, dpr, cssRect, identity} или {error}.
 */
export function planCapture({ imgW, imgH, viewW, viewH, rect, scale }) {
  if (!(imgW > 0 && imgH > 0 && viewW > 0 && viewH > 0)) return { error: "нет размеров снимка или вьюпорта" };
  const kx = imgW / viewW;
  const ky = imgH / viewH;
  const dpr = Math.round(kx * 100) / 100;
  if (!rect) {
    const k = Math.min(1, capFactor(imgW, imgH));
    const outW = Math.max(1, Math.round(imgW * k));
    const outH = Math.max(1, Math.round(imgH * k));
    return { sx: 0, sy: 0, sw: imgW, sh: imgH, outW, outH, dpr, cssRect: { x: 0, y: 0, w: viewW, h: viewH }, identity: outW === imgW && outH === imgH };
  }
  const x0 = Math.max(0, Number(rect.x) || 0);
  const y0 = Math.max(0, Number(rect.y) || 0);
  const x1 = Math.min(viewW, (Number(rect.x) || 0) + (Number(rect.w) || 0));
  const y1 = Math.min(viewH, (Number(rect.y) || 0) + (Number(rect.h) || 0));
  if (!(x1 - x0 >= 1 && y1 - y0 >= 1)) return { error: "область вне видимой части вкладки — прокрути к ней (scroll_to) или сними без rect" };
  const sx = Math.min(imgW - 1, Math.round(x0 * kx));
  const sy = Math.min(imgH - 1, Math.round(y0 * ky));
  const sw = Math.max(1, Math.min(imgW - sx, Math.round((x1 - x0) * kx)));
  const sh = Math.max(1, Math.min(imgH - sy, Math.round((y1 - y0) * ky)));
  const want = Number(scale) > 0 ? Math.min(Number(scale), 2) : Math.min(2, MAX_SIDE / Math.max(sw, sh));
  const k = Math.min(want, capFactor(sw, sh));
  const outW = Math.max(1, Math.round(sw * k));
  const outH = Math.max(1, Math.round(sh * k));
  return { sx, sy, sw, sh, outW, outH, dpr, cssRect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, identity: false };
}

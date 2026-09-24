/**
 * Окно-оверлей режима выделения (§2026-09-03): владелец обводит мышью кусок экрана.
 *
 * Два режима одного и того же окна:
 *  • "draw"  — вуаль + крестовина, тянем прямоугольник, отпустили → отдаём main. Esc / правая кнопка /
 *              клик без протяжки = отмена (main трактует её как «выделения нет», а не как ошибку).
 *  • "frame" — вуали нет, окно click-through: висит только рамка вокруг области.
 *
 * Рамка рисуется СНАРУЖИ прямоугольника (border за его границей). Это важно: окно ПОПАДАЕТ в
 * собственный screen_capture (замерено живьём: setContentProtection на прозрачном окне Windows не
 * действует) — синие линии не должны ложиться поверх содержимого, о котором говорит владелец.
 */
interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface OverlayMode {
  mode: "draw" | "frame";
  rect?: OverlayRect;
}
declare const window: Window & {
  selectionOverlay?: {
    onMode(cb: (m: OverlayMode) => void): void;
    submit(rect: OverlayRect | null): void;
  };
};

const BORDER = 2;
const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const veil = el("veil");
const hole = el("hole");
const box = el("box");
const label = el("label");
const hint = el("hint");

let start: { x: number; y: number } | null = null;
let sent = false;

/** Прямоугольник по двум точкам (тянуть можно в любую сторону). */
function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): OverlayRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function paint(r: OverlayRect, withLabel: string | null): void {
  box.style.display = "block";
  box.style.left = `${r.x - BORDER}px`;
  box.style.top = `${r.y - BORDER}px`;
  box.style.width = `${r.w}px`;
  box.style.height = `${r.h}px`;
  hole.style.display = "block";
  hole.style.left = `${r.x}px`;
  hole.style.top = `${r.y}px`;
  hole.style.width = `${r.w}px`;
  hole.style.height = `${r.h}px`;
  if (withLabel === null) {
    label.style.display = "none";
    return;
  }
  label.textContent = withLabel;
  label.style.display = "block";
  label.style.left = `${r.x - BORDER}px`;
  label.style.top = `${Math.max(0, r.y - BORDER - 20)}px`;
}

/** Отдать результат ровно один раз: повторный submit после закрытия окна — гонка мыши и Esc. */
function finish(r: OverlayRect | null): void {
  if (sent) return;
  sent = true;
  window.selectionOverlay?.submit(r);
}

function enableDraw(): void {
  veil.style.display = "block";
  hint.style.display = "block";
  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0) {
      finish(null); // правая/средняя кнопка — отмена
      return;
    }
    start = { x: e.clientX, y: e.clientY };
    paint({ x: start.x, y: start.y, w: 0, h: 0 }, null);
  });
  window.addEventListener("mousemove", (e) => {
    if (!start) return;
    const r = rectOf(start, { x: e.clientX, y: e.clientY });
    paint(r, `${Math.round(r.w)}×${Math.round(r.h)}`);
  });
  window.addEventListener("mouseup", (e) => {
    if (!start) return;
    const r = rectOf(start, { x: e.clientX, y: e.clientY });
    start = null;
    finish(r);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") finish(null);
  });
  // Мышь ушла на другой монитор и там отпустили — это окно результата не получит; отмену пришлёт
  // либо соседнее окно, либо Esc. Ничего не «додумываем» за владельца.
}

function showFrame(r: OverlayRect): void {
  veil.style.display = "none";
  hint.style.display = "none";
  hole.style.background = "transparent";
  // Без текстовой метки: окно-рамка попадает в собственный screen_capture (замерено живьём), и надпись
  // читалась бы OCR как текст на экране. Сама рамка владельцу и так понятна — он её только что обвёл.
  paint(r, null);
}

window.selectionOverlay?.onMode((m) => {
  if (m.mode === "draw") enableDraw();
  else if (m.rect) showFrame(m.rect);
});

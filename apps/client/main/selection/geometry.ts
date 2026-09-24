/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ — геометрия рамки. Чистый модуль без Electron: прямоугольник приходит из окна-оверлея
 * (мышью), и его надо привести к реальности ДО того, как он станет «местом, на которое показывает
 * владелец».
 */
export interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Обрезать локальный прямоугольник границами окна. Протяжку могли начать здесь, а отпустить на СОСЕДНЕМ
 * мониторе — координаты выходят за окно, и без обрезки кроп молча зажался бы в клиенте: модель увидела бы
 * НЕ то, что обвёл владелец. Ничего не осталось (рамка целиком мимо) → null: это не выделение.
 */
export function clipToWindow(r: OverlayRect, width: number, height: number): OverlayRect | null {
  const x1 = Math.max(0, Math.min(width, r.x));
  const y1 = Math.max(0, Math.min(height, r.y));
  const x2 = Math.max(0, Math.min(width, r.x + r.w));
  const y2 = Math.max(0, Math.min(height, r.y + r.h));
  const w = x2 - x1;
  const h = y2 - y1;
  return w > 0 && h > 0 ? { x: x1, y: y1, w, h } : null;
}

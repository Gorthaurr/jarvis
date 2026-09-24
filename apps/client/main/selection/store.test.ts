/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ — состояние и геометрия (чистое, без Electron).
 *
 * Каждый кейс охраняет ЧЕСТНОСТЬ указателя: «выделение есть» должно означать, что владелец РЕАЛЬНО
 * обвёл видимую область на существующем мониторе. Промах мышью, рамка мимо экрана и осиротевшие после
 * переключения монитора координаты — это «выделения нет», а не «показывает сюда».
 */
import { describe, expect, it, vi } from "vitest";
import { MIN_SIDE_DIP, SelectionStore, normalizeSelection, selectionOrphaned } from "./store.js";
import { clipToWindow } from "./geometry.js";

const base = { x: 100, y: 50, w: 640, h: 360, monitorIndex: 1, monitor: "Монитор 2", createdAt: 1000 };

describe("normalizeSelection", () => {
  it("округляет дробные координаты мыши и сохраняет монитор", () => {
    const s = normalizeSelection({ ...base, x: 100.4, w: 639.6 });
    expect(s).toMatchObject({ x: 100, w: 640, monitorIndex: 1, monitor: "Монитор 2" });
  });

  it("клик без протяжки — НЕ выделение (иначе Джарвис «смотрел» бы в точку)", () => {
    expect(normalizeSelection({ ...base, w: MIN_SIDE_DIP - 1, h: 300 })).toBeNull();
    expect(normalizeSelection({ ...base, w: 300, h: 0 })).toBeNull();
  });
});

describe("clipToWindow", () => {
  it("протяжка за край монитора обрезается по окну", () => {
    expect(clipToWindow({ x: -50, y: 10, w: 200, h: 100 }, 1000, 800)).toEqual({ x: 0, y: 10, w: 150, h: 100 });
  });

  it("рамка целиком за экраном — не выделение", () => {
    expect(clipToWindow({ x: 1200, y: 10, w: 100, h: 100 }, 1000, 800)).toBeNull();
  });
});

describe("selectionOrphaned (смена конфигурации мониторов)", () => {
  const sel = normalizeSelection(base)!;
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 2560, height: 1440 },
  ];

  it("тот же монитор и та же геометрия → выделение живо", () => {
    expect(selectionOrphaned(sel, displays)).toBe(false);
  });

  it("монитор отключили → осиротело (нельзя утверждать, что владелец показывает)", () => {
    expect(selectionOrphaned(sel, [displays[0]!])).toBe(true);
  });

  it("разрешение/расположение сменилось так, что область вылезла за экран → осиротело", () => {
    expect(selectionOrphaned(sel, [displays[0]!, { x: 0, y: 0, width: 640, height: 480 }])).toBe(true);
  });

  it("нет выделения — нечему сиротеть", () => {
    expect(selectionOrphaned(null, displays)).toBe(false);
  });
});

describe("SelectionStore — фаза рисования (единая точка правды для гейта ввода)", () => {
  it("вне рисования физический ввод не блокируется; во время — причина о СОСТОЯНИИ системы, не о владельце", () => {
    const store = new SelectionStore();
    expect(store.physicalInputBlockReason(1000)).toBeNull();
    store.setDrawing(true, 1000);
    const reason = store.physicalInputBlockReason(4000)!;
    expect(reason).toContain("оверлей");
    expect(reason).toContain("3 с");
    expect(reason).not.toMatch(/владелец прямо сейчас обводит/u);
    store.setDrawing(false);
    expect(store.physicalInputBlockReason()).toBeNull();
  });
});

describe("SelectionStore", () => {
  it("подписчик узнаёт о смене и о снятии, повтор того же не шлётся", () => {
    const store = new SelectionStore();
    const seen: (unknown | null)[] = [];
    store.onChange((s) => seen.push(s));
    const sel = normalizeSelection(base)!;
    store.set(sel);
    store.set(normalizeSelection(base)!); // то же самое — второй раз не уведомляем
    store.clear();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ w: 640 });
    expect(seen[1]).toBeNull();
  });

  it("возраст считается от момента выделения; без выделения — null, а не ноль", () => {
    const store = new SelectionStore();
    expect(store.ageMs(5000)).toBeNull();
    store.set(normalizeSelection(base)!);
    expect(store.ageMs(5000)).toBe(4000);
  });

  it("падение подписчика не ломает смену состояния (транспорт мог отвалиться)", () => {
    const store = new SelectionStore();
    store.onChange(() => {
      throw new Error("транспорт лёг");
    });
    const ok = vi.fn();
    store.onChange(ok);
    store.set(normalizeSelection(base)!);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(store.active).toBe(true);
  });
});

describe("контроль-4: вуаль перекрывала окно команды", () => {
  it("drawingEndedAfter(t) — вуаль, закрывшаяся ПОСЛЕ старта команды, перекрывала её; закрывшаяся раньше — нет", () => {
    const st = new SelectionStore();
    expect(st.drawingEndedAfter(0)).toBe(false); // вуали не было вовсе
    st.setDrawing(true, 1_000);
    st.setDrawing(false, 2_000);
    expect(st.drawingEndedAfter(1_500)).toBe(true); // команда началась в 1500, вуаль закрылась в 2000
    expect(st.drawingEndedAfter(2_500)).toBe(false); // команда началась после закрытия
    expect(st.drawingEndedAfter(2_000)).toBe(false); // началась ровно в момент закрытия — вуали уже не было
    st.setDrawing(false, 3_000); // повторное «выкл» без открытой вуали момент не двигает
    expect(st.drawingEndedAfter(2_500)).toBe(false);
  });
});

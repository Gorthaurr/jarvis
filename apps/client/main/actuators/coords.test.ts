/**
 * W2 П5: единый перевод координат — КАДРЫ вместо «последнего снимка». Точка модели в f/z-кадре на двух мониторах
 * (100 % и 150 %) → ожидаемый DIP численно; без кадра и без space — ошибка (а не клик по догадке); физика ↔ DIP через
 * внедряемый Electron `screen` (на Linux Windows-API нет — мок считает по масштабу).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);

import { resetElectronMock } from "../test-support/electron-mock.js";
import { NoFrameError, OutOfFrameError, UnknownFrameError, dipToPhysicalPoint, physicalRectToDip, rectToDip, setScreenApi, toDipPoint } from "./coords.js";
import { _resetFramesForTest, registerFrame } from "./frames.js";

// Монитор 0: 1920×1080 @100 % в (0,0). Монитор 1: 2560×1440 физ. @150 % = 1706.67×960 DIP справа, в (1920, 0).
const M1 = { x: 1920, y: 0, width: 1707, height: 960 };

beforeEach(() => {
  _resetFramesForTest("t1a");
  resetElectronMock({ scale: 1.5 });
});
afterEach(() => setScreenApi(null));

describe("toDipPoint / rectToDip — кадры", () => {
  it("f-кадр монитора 150 % (копия 1920 из натива 2559): точка → DIP = origin + x/sx", () => {
    // Натив 2559×1439 ужат до 1920×1080 → 1920/1707 px на DIP по x, 1080/960 по y.
    const f = registerFrame({ kind: "f", displayId: 2, boundsDIP: M1, origin: { x: 1920, y: 0 }, sx: 1920 / 1707, sy: 1080 / 960, w: 1920, h: 1080 });
    const p = toDipPoint(960, 540, { frame: f.id });
    expect(p.x).toBeCloseTo(1920 + 853.5, 6);
    expect(p.y).toBeCloseTo(480, 6);
  });

  it("z-кадр: origin зума (не монитора) — формула без origin зума промахнулась бы на сотни DIP", () => {
    // Зум региона монитора 1: левый верх в DIP (2400, 300), натив ×1,5 и ещё ×2 → 3 px картинки на DIP.
    const z = registerFrame({ kind: "z", displayId: 2, boundsDIP: M1, origin: { x: 2400, y: 300 }, sx: 3, sy: 3, w: 600, h: 300, zoomOf: "t1af1" });
    expect(toDipPoint(300, 150, { frame: z.id })).toEqual({ x: 2500, y: 350 });
    expect(rectToDip({ x: 30, y: 60, w: 90, h: 30, frame: z.id })).toEqual({ x: 2410, y: 320, w: 30, h: 10 });
  });

  it("монитор 100 % в (0,0) и 150 % справа: одна и та же точка кадра — разные DIP по своим кадрам", () => {
    const a = registerFrame({ kind: "f", displayId: 1, boundsDIP: { x: 0, y: 0, width: 1920, height: 1080 }, origin: { x: 0, y: 0 }, sx: 1, sy: 1, w: 1920, h: 1080 });
    const b = registerFrame({ kind: "f", displayId: 2, boundsDIP: M1, origin: { x: 1920, y: 0 }, sx: 1920 / 1707, sy: 1080 / 960, w: 1920, h: 1080 });
    expect(toDipPoint(100, 100, { frame: a.id })).toEqual({ x: 100, y: 100 });
    const pb = toDipPoint(100, 100, { frame: b.id });
    expect(pb.x).toBeCloseTo(1920 + 100 * (1707 / 1920), 6);
    expect(pb.y).toBeCloseTo(100 * (960 / 1080), 6);
  });

  it("без кадра и без space — NoFrameError (догадки по «последнему снимку» больше нет)", () => {
    expect(() => toDipPoint(1, 2)).toThrow(NoFrameError);
    expect(() => rectToDip({ x: 1, y: 2, w: 3, h: 4 })).toThrow(/сначала screen_capture/u);
  });

  it("space:'screen' — абсолютные DIP как есть и главнее кадра (SDK/§8)", () => {
    expect(toDipPoint(100, 40, { space: "screen" })).toEqual({ x: 100, y: 40 });
    expect(toDipPoint(1, 2, { frame: "t1af999", space: "screen" })).toEqual({ x: 1, y: 2 });
    expect(rectToDip({ x: 1, y: 2, w: 3, h: 4, space: "screen" })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("неизвестный кадр → UnknownFrameError «пересними»; точка вне картинки кадра → OutOfFrameError (натив вместо кадра)", () => {
    expect(() => toDipPoint(1, 2, { frame: "t1af77" })).toThrow(UnknownFrameError);
    expect(() => toDipPoint(1, 2, { frame: "t1af77" })).toThrow(/пересними screen_capture/u);
    const f = registerFrame({ kind: "f", displayId: 1, boundsDIP: { x: 0, y: 0, width: 3840, height: 2160 }, origin: { x: 0, y: 0 }, sx: 1568 / 3840, sy: 882 / 2160, w: 1568, h: 882 });
    expect(() => toDipPoint(3000, 100, { frame: f.id })).toThrow(OutOfFrameError);
    expect(() => rectToDip({ x: 2000, y: 10, w: 50, h: 50, frame: f.id })).toThrow(/вне кадра/u);
  });
});

describe("физика ↔ DIP (Electron screen внедряется)", () => {
  it("масштаб 150 %: физический rect окна → DIP, DIP-точка → физика", () => {
    expect(physicalRectToDip({ x: 300, y: 150, w: 600, h: 300 })).toEqual({ x: 200, y: 100, w: 400, h: 200 });
    expect(dipToPhysicalPoint({ x: 200, y: 100 })).toEqual({ x: 300, y: 150 });
  });

  it("подменённый API главнее; без Windows-API — как есть", () => {
    setScreenApi({ screenToDipRect: (_w, r) => ({ x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2 }) });
    expect(physicalRectToDip({ x: 10, y: 10, w: 10, h: 10 })).toEqual({ x: 5, y: 5, w: 5, h: 5 });
    setScreenApi({});
    expect(physicalRectToDip({ x: 10, y: 10, w: 10, h: 10 })).toEqual({ x: 10, y: 10, w: 10, h: 10 });
    expect(dipToPhysicalPoint({ x: 7, y: 8 })).toEqual({ x: 7, y: 8 });
  });
});

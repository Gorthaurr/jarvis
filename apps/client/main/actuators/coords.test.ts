/**
 * W2 (пакет 0): единый перевод координат — те же числа, что давали пять прежних копий формулы, плюс честный отказ на
 * неизвестный кадр и физика ↔ DIP через внедряемый Electron `screen` (на Linux Windows-API нет — мок считает по масштабу).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ mapping: null as null | { boundsX: number; boundsY: number; scale: number } }));
vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./screen.js", () => ({ getLastCaptureMapping: () => m.mapping }));

import { resetElectronMock } from "../test-support/electron-mock.js";
import { UnknownFrameError, dipToPhysicalPoint, physicalRectToDip, rectToDip, setScreenApi, toDipPoint } from "./coords.js";

beforeEach(() => {
  m.mapping = { boundsX: 1920, boundsY: 0, scale: 0.5 }; // второй монитор справа, кадр в 2 раза меньше
  resetElectronMock({ scale: 1.5 });
});
afterEach(() => setScreenApi(null));

describe("toDipPoint / rectToDip", () => {
  it("координаты последнего кадра → DIP: boundsX + x/scale (как у прежних копий)", () => {
    expect(toDipPoint(100, 40)).toEqual({ x: 2120, y: 80 });
    expect(rectToDip({ x: 100, y: 40, w: 50, h: 10 })).toEqual({ x: 2120, y: 80, w: 100, h: 20 });
  });

  it("space:'screen' — абсолютные DIP как есть; без снимка — как есть (честная деградация)", () => {
    expect(toDipPoint(100, 40, { space: "screen" })).toEqual({ x: 100, y: 40 });
    m.mapping = null;
    expect(toDipPoint(100, 40)).toEqual({ x: 100, y: 40 });
    expect(rectToDip({ x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("кадр, которого клиент не знает (P0 — любой) → ошибка, а не клик мимо по lastMapping", () => {
    expect(() => toDipPoint(1, 2, { frame: "k7f12" })).toThrow(UnknownFrameError);
    expect(() => rectToDip({ x: 1, y: 2, w: 3, h: 4, frame: "k7f12" })).toThrow(/пересними screen_capture/u);
    expect(toDipPoint(1, 2, { frame: "k7f12", space: "screen" })).toEqual({ x: 1, y: 2 }); // SDK/§8 — space главнее
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

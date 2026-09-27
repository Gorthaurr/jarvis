/**
 * W2 П5 (G-4, G-6): захват в НАТИВЕ, копия под кап зрения, зум = новый захват кропом натива, масштаб — по РЕАЛЬНОМУ
 * размеру миниатюры. Настоящие screen.ts / screen-grab.ts / screen-native.ts / frames.ts / coords.ts; фейк —
 * только desktopCapturer (картинка помнит, какой кусок физического экрана показывает: test-support/fake-capturer).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("../test-support/fake-capturer.js")).fakeElectronModule());
vi.mock("./sidecar-client.js", () => ({ sidecar: () => ({ ready: false, request: async () => ({}) }) }));

import { VISION_CAPS } from "@jarvis/shared";
import { capturer, provOf, resetCapturer } from "../test-support/fake-capturer.js";
import { toDipPoint } from "./coords.js";
import { _resetFramesForTest, getFrame } from "./frames.js";
import { captureScreen } from "./screen.js";

const HIGH = { maxEdge: VISION_CAPS.high.frameEdge, maxPixels: VISION_CAPS.high.maxPixels };
const K4 = { id: 7, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5 }; // 4K-панель @150 %

beforeEach(() => {
  _resetFramesForTest("c5a");
  resetCapturer([K4]);
});

describe("полный кадр: натив → копия под кап", () => {
  it("thumbnailSize = натив (DIP × scaleFactor); std-кап — 1568 и 1,15 Мп; high — 1920 (кадр 1080p-класса)", async () => {
    const std = await captureScreen("0");
    expect(capturer.requests[0]).toEqual({ width: 3840, height: 2160 }); // натив, а не миниатюра 1568
    expect(Math.max(std.width, std.height)).toBeLessThanOrEqual(1568);
    expect(std.width * std.height).toBeLessThanOrEqual(1_150_000);
    expect(std).toMatchObject({ width: 1429, height: 804 }); // площадь сжала сильнее длинной стороны
    expect(provOf(std.image)).toMatchObject({ ox: 0, oy: 0, w: 1429 }); // копия всего натива, ужатая
    const high = await captureScreen("0", HIGH);
    expect(high).toMatchObject({ width: 1920, height: 1080, frameId: "c5af2" });
  });

  it("кадр зарегистрирован: центр картинки → центр монитора в DIP", async () => {
    const shot = await captureScreen("0", HIGH);
    const f = getFrame(shot.frameId!);
    expect(f).toMatchObject({ kind: "f", displayId: 7, w: 1920, h: 1080, origin: { x: 0, y: 0 } });
    expect(toDipPoint(960, 540, { frame: f.id })).toEqual({ x: 1280, y: 720 });
  });

  it("масштаб — по РЕАЛЬНОМУ getSize(): захват отдал 1920×1080 вместо запрошенных 3840×2160 — кадр и зум всё равно точны", async () => {
    capturer.actual = () => ({ width: 1920, height: 1080 });
    const shot = await captureScreen("0", HIGH);
    expect(toDipPoint(960, 540, { frame: shot.frameId! })).toEqual({ x: 1280, y: 720 });
    // Зум региона (в кадре) режется из того, что реально пришло: 200×100 px кадра у (100,100) = DIP (133.3,133.3)…
    const z = await captureScreen(undefined, { rect: { x: 100, y: 100, w: 200, h: 100, frame: shot.frameId! }, ...HIGH });
    const p = provOf(z.image);
    expect(p.ox).toBeCloseTo(200, 6); // физика = DIP × 1,5 — даже при половинной миниатюре
    expect(toDipPoint(0, 0, { frame: z.frameId! }).x).toBeCloseTo(133.333, 2);
  });

  it("случай 2559×1439 (Xvfb @150 %): масштаб по осям раздельный, точка кадра — в свой DIP", async () => {
    resetCapturer([{ id: 3, bounds: { x: 0, y: 0, width: 1706, height: 960 }, scaleFactor: 1.5 }]);
    capturer.actual = () => ({ width: 2559, height: 1439 });
    const shot = await captureScreen("0", HIGH);
    const f = getFrame(shot.frameId!);
    expect(f.sx).toBeCloseTo(shot.width / 1706, 9);
    expect(f.sy).toBeCloseTo(shot.height / 960, 9);
    const p = toDipPoint(shot.width, shot.height, { frame: f.id });
    expect(p.x).toBeCloseTo(1706, 6);
    expect(p.y).toBeCloseTo(960, 6);
  });
});

describe("зум = новый захват кропом натива", () => {
  it("кадр ужат (натив 3840 → 1920) → кроп натива ×1, z-кадр со своей системой; точка зума → верный DIP", async () => {
    const f = await captureScreen("0", HIGH);
    const z = await captureScreen(undefined, { rect: { x: 960, y: 540, w: 192, h: 108, frame: f.frameId! }, maxEdge: 2576, maxPixels: 3_750_000 });
    expect(capturer.requests).toHaveLength(2); // лупа — СВЕЖИЙ снимок, а не кроп старой миниатюры
    expect(provOf(z.image)).toMatchObject({ ox: 1920, oy: 1080, kx: 1, ky: 1, w: 384, h: 216 }); // натив, без мыла
    expect(z).toMatchObject({ zoomOf: f.frameId, frameId: "c5az2" });
    // Регион 192×108 px кадра = 256×144 DIP от (1280, 720); середина картинки зума = DIP (1280 + 128, 720 + 72).
    expect(toDipPoint(192, 108, { frame: z.frameId! })).toEqual({ x: 1408, y: 792 });
  });

  it("кадр НЕ ужат (монитор 1080p, копия = натив) → зум ×2; второй монитор справа — origin зума, а не монитора", async () => {
    resetCapturer([
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    ]);
    const f = await captureScreen("1", HIGH);
    const z = await captureScreen(undefined, { rect: { x: 100, y: 200, w: 300, h: 150, frame: f.frameId! }, maxEdge: 2576, maxPixels: 3_750_000 });
    expect(provOf(z.image)).toMatchObject({ display: 2, ox: 100, oy: 200, kx: 2, w: 600, h: 300 });
    expect(toDipPoint(300, 150, { frame: z.frameId! })).toEqual({ x: 1920 + 250, y: 275 });
  });

  it("регион снимается с монитора СВОЕГО кадра, даже если курсор/передний план на другом", async () => {
    resetCapturer([
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 2 },
    ]);
    const f = await captureScreen("1", HIGH); // монитор 2 (@200 %)
    capturer.cursor = { x: 10, y: 10 }; // курсор ушёл на монитор 1
    const z = await captureScreen(undefined, { rect: { x: 0, y: 0, w: 100, h: 100, frame: f.frameId! } });
    expect(provOf(z.image).display).toBe(2);
  });

  it("зум по кэпу: регион крупнее капа ужимается (≤ maxEdge и maxPixels), scale модели главнее умолчания", async () => {
    const f = await captureScreen("0", HIGH);
    const big = await captureScreen(undefined, { rect: { x: 0, y: 0, w: 1920, h: 1080, frame: f.frameId! }, maxEdge: 2576, maxPixels: 3_750_000 });
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(2576);
    expect(big.width * big.height).toBeLessThanOrEqual(3_750_000);
    const half = await captureScreen(undefined, { rect: { x: 0, y: 0, w: 200, h: 100, frame: f.frameId! }, scale: 0.5 });
    expect(provOf(half.image)).toMatchObject({ kx: 0.5, w: 200 }); // натив 400 × 0,5
  });

  it("rect в неизвестном кадре / без кадра → ошибка, захвата нет", async () => {
    await expect(captureScreen(undefined, { rect: { x: 0, y: 0, w: 10, h: 10, frame: "c5af99" } })).rejects.toThrow(/устарел, пересними/u);
    await expect(captureScreen(undefined, { rect: { x: 0, y: 0, w: 10, h: 10 } })).rejects.toThrow(/координаты без кадра/u);
    expect(capturer.requests).toHaveLength(0);
  });
});

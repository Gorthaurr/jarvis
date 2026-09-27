/**
 * W2 П5: OCR в НАТИВЕ и строки в системе кадра задачи. Настоящие screen-ocr / screen-ocr-tiles / screen-grab / frames /
 * coords; фейки — desktopCapturer (картинка помнит свой кусок физического экрана) и сайдкар в реальной форме, чей OCR
 * «видит» слова, лежащие в физических пикселях монитора (test-support/fake-capturer: ocrSees).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("../test-support/fake-capturer.js")).fakeElectronModule());
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { VISION_CAPS } from "@jarvis/shared";
import { type Prov, type ScreenWord, ocrSees, provOf, resetCapturer } from "../test-support/fake-capturer.js";
import { useFakeSidecar } from "../test-support/fake-sidecar.js";
import { OutOfFrameError, toDipPoint } from "./coords.js";
import { _resetFramesForTest, getFrame } from "./frames.js";
import { captureScreen } from "./screen.js";
import { screenOcr } from "./screen-ocr.js";

const HIGH = { maxEdge: VISION_CAPS.high.frameEdge, maxPixels: VISION_CAPS.high.maxPixels };
const UHD = { id: 1, bounds: { x: 0, y: 0, width: 3840, height: 2160 }, scaleFactor: 1 }; // 4K @100 %
const PLAY: ScreenWord = { display: 1, text: "Играть", x: 3000, y: 1500, w: 120, h: 40 };

let words: ScreenWord[];
let sent: Prov[];
const center = (l: { x: number; y: number; w: number; h: number }) => ({ x: l.x + l.w / 2, y: l.y + l.h / 2 });

beforeEach(() => {
  _resetFramesForTest("o3c");
  resetCapturer([UHD]);
  const side = useFakeSidecar();
  words = [PLAY];
  sent = [];
  side.handlers.ocr = (a) => {
    sent.push(provOf(String(a.imageB64)));
    return ocrSees(words, String(a.imageB64));
  };
});

describe("в сайдкар уходит натив", () => {
  it("4K: полосы ≤ 2600 с перекрытием (натив, без ужатия); строка из перекрытия — ровно один раз", async () => {
    words = [PLAY, { display: 1, text: "Шов", x: 1890, y: 500, w: 60, h: 30 }]; // целиком в перекрытии полос
    const r = await screenOcr("0");
    expect(sent).toHaveLength(2);
    for (const p of sent) expect(p).toMatchObject({ kx: 1, ky: 1 });
    expect(sent.every((p) => p.w <= 2600 && p.h <= 2600)).toBe(true);
    expect(sent[1]!.ox).toBeLessThan(sent[0]!.ox + sent[0]!.w); // перекрываются
    expect(r.lines.map((l) => l.text).sort()).toEqual(["Играть", "Шов"]);
    expect(r.lines.find((l) => l.text === "Играть")).toEqual({ text: "Играть", x: 3000, y: 1500, w: 120, h: 40 });
  });

  it("мелкий регион → ×2 (кламп 2600); строки — в кадре задачи, frame назван", async () => {
    const f = await captureScreen("0", HIGH); // 1920×1080 из натива 3840 → 0,5 px на DIP
    const r = await screenOcr(undefined, { x: 1400, y: 700, w: 200, h: 100, frame: f.frameId! }, undefined, { frame: f.frameId! });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ox: 2800, oy: 1400, kx: 2, w: 800, h: 400 }); // натив 400×200 ×2
    expect(r.frame).toBe(f.frameId);
    expect(r.lines).toEqual([{ text: "Играть", x: 1500, y: 750, w: 60, h: 20 }]);
    expect(r.mapping).toEqual({ boundsX: 0, boundsY: 0, scale: 0.5 });
  });
});

describe("система строк: кадр задачи или свой o-кадр", () => {
  it("capture std → OCR (натив 3840) → клик: по строке — верный DIP; «x:3000» из натива — ошибка, никогда промах", async () => {
    const f = await captureScreen("0"); // std: 1429×804
    const r = await screenOcr("0", undefined, undefined, { frame: f.frameId! });
    expect(r.frame).toBe(f.frameId);
    const line = r.lines.find((l) => l.text === "Играть")!;
    expect(line.x).toBeLessThan(f.width); // в системе кадра, а не натива
    const p = toDipPoint(center(line).x, center(line).y, { frame: f.frameId! });
    expect(Math.abs(p.x - 3060)).toBeLessThan(3);
    expect(Math.abs(p.y - 1520)).toBeLessThan(3);
    expect(() => toDipPoint(3000, 750, { frame: f.frameId! })).toThrow(OutOfFrameError);
  });

  it("кадра задачи нет → строки в своём o-кадре (register): клик по строке в нём — точный DIP", async () => {
    const r = await screenOcr("0", undefined, undefined, { register: true });
    expect(r.frame).toBeUndefined();
    expect(r.frameId).toBe("o3co1");
    expect(getFrame("o3co1")).toMatchObject({ kind: "o", w: 3840, h: 2160 });
    const line = r.lines[0]!;
    expect(toDipPoint(center(line).x, center(line).y, { frame: r.frameId! })).toEqual({ x: 3060, y: 1520 });
  });

  it("кадр задачи с ДРУГОГО монитора → строки в o-кадре, frame не ставится (иначе координаты вне картинки)", async () => {
    resetCapturer([UHD, { id: 2, bounds: { x: 3840, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }]);
    const f = await captureScreen("1", HIGH); // монитор 2
    const r = await screenOcr("0", undefined, undefined, { frame: f.frameId!, register: true });
    expect(r.frame).toBeUndefined();
    expect(r.lines[0]).toMatchObject({ text: "Играть", x: 3000 });
  });

  it("SDK: mapping отдаётся и для rect (space:'screen', монитор 150 %) — строка → экранный DIP", async () => {
    resetCapturer([{ id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5 }]); // натив 3840
    const r = await screenOcr(undefined, { x: 1900, y: 950, w: 300, h: 150, space: "screen" });
    const line = r.lines[0]!;
    const m = r.mapping;
    expect(m.boundsX + center(line).x / m.scale).toBeCloseTo(2040, 0); // слово в физике 3060 = DIP 2040
    expect(m.boundsY + center(line).y / m.scale).toBeCloseTo(1013.3, 0);
  });

  it("датчиковый OCR (без register) кадров не регистрирует", async () => {
    const r = await screenOcr("0");
    expect(r.frameId).toBeUndefined();
    expect(() => getFrame("o3co1")).toThrow(/устарел/u);
  });
});

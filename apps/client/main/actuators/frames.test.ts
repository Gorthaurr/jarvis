/**
 * W2 П5: реестр кадров — LRU только метаданных, id с меткой загрузки. Вытесненный кадр и кадр прошлой загрузки клиента →
 * «кадр устарел, пересними» (никакого фолбэка на «последний снимок»); освежённый чтением кадр не вытесняется.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  FRAME_LRU_MAX,
  UnknownFrameError,
  _resetFramesForTest,
  bootTag,
  dipRectToFrame,
  dipToFrame,
  frameToDip,
  getFrame,
  mappingOf,
  registerFrame,
} from "./frames.js";

const base = { displayId: 1, boundsDIP: { x: 0, y: 0, width: 1920, height: 1080 }, origin: { x: 0, y: 0 }, sx: 0.5, sy: 0.5, w: 960, h: 540 };

beforeEach(() => _resetFramesForTest("q4k"));

describe("id и вид кадра", () => {
  it("id = <bootTag><вид><n>: полный f, зум z, OCR o, выделение s — номера растут", () => {
    expect(bootTag()).toBe("q4k");
    expect(registerFrame({ ...base, kind: "f" }).id).toBe("q4kf1");
    expect(registerFrame({ ...base, kind: "z" }).id).toBe("q4kz2");
    expect(registerFrame({ ...base, kind: "o" }).id).toBe("q4ko3");
    expect(registerFrame({ ...base, kind: "s" }).id).toBe("q4ks4");
  });

  it("метка загрузки по умолчанию: 3 знака без букв видов кадра (f/z/o/s)", () => {
    _resetFramesForTest();
    expect(bootTag()).toMatch(/^[a-z][0-9][a-z]$/u);
    expect(bootTag()).not.toMatch(/[fzos]/u);
  });
});

describe("LRU и устаревание", () => {
  it("вытесненный (65-й кадр выдавил 1-й) → UnknownFrameError «вытеснен … пересними»", () => {
    const first = registerFrame({ ...base, kind: "f" });
    for (let i = 0; i < FRAME_LRU_MAX; i += 1) registerFrame({ ...base, kind: "o" });
    expect(() => getFrame(first.id)).toThrow(UnknownFrameError);
    expect(() => getFrame(first.id)).toThrow(/вытеснен.*кадр устарел, пересними/su);
  });

  it("чтение освежает кадр: активный кадр задачи не вытесняется потоком OCR-кадров", () => {
    const task = registerFrame({ ...base, kind: "f" });
    for (let i = 0; i < FRAME_LRU_MAX * 2; i += 1) {
      registerFrame({ ...base, kind: "o" });
      if (i % 10 === 0) getFrame(task.id); // задача кликает по своему кадру
    }
    expect(getFrame(task.id).id).toBe(task.id);
  });

  it("кадр прошлой загрузки клиента (чужой bootTag) → «снят до перезапуска … пересними»", () => {
    const old = registerFrame({ ...base, kind: "f" });
    _resetFramesForTest("w7b"); // клиент перезапущен
    expect(() => getFrame(old.id)).toThrow(/до перезапуска клиента.*пересними/su);
  });
});

describe("геометрия", () => {
  it("кадр ↔ DIP туда-обратно; регион; маппинг SDK (DIP = boundsX + x/scale)", () => {
    const f = registerFrame({ ...base, kind: "z", origin: { x: 2000, y: 100 }, sx: 2, sy: 2 });
    expect(frameToDip(f, 200, 50)).toEqual({ x: 2100, y: 125 });
    expect(dipToFrame(f, { x: 2100, y: 125 })).toEqual({ x: 200, y: 50 });
    expect(dipRectToFrame(f, { x: 2010, y: 110, w: 5, h: 5 })).toEqual({ x: 20, y: 20, w: 10, h: 10 });
    expect(mappingOf(f)).toEqual({ boundsX: 2000, boundsY: 100, scale: 2 });
  });

  it("кромка картинки допустима (±1 px), дальше — вне кадра", () => {
    const f = registerFrame({ ...base, kind: "f" });
    expect(() => frameToDip(f, 960, 540)).not.toThrow();
    expect(() => frameToDip(f, 961, 0)).not.toThrow();
    expect(() => frameToDip(f, 962, 0)).toThrow(/вне кадра/u);
    expect(() => frameToDip(f, -2, 0)).toThrow(/вне кадра/u);
    expect(() => frameToDip(f, Number.NaN, 0)).toThrow(/вне кадра/u);
  });
});

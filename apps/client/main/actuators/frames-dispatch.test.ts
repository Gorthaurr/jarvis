/**
 * W2 П5: кадры ПРОВОДКОЙ через настоящий dispatch актуаторов (index.ts): screen.capture → кадр; ui.snapshot{frame} →
 * bbox в кадре; screen.ocr{frame} → строки в кадре; input.click{x,y,frame} → сайдкар получает ТОЧНЫЙ DIP кнопки.
 * Монитор 4K @150 % (натив 3840, DIP 2560), кадр модели 1920 — три системы координат, и все сходятся.
 * Фейки — только края: desktopCapturer (картинка помнит свой кусок физики) и сайдкар в реальной форме.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("../test-support/fake-capturer.js")).fakeElectronModule());
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());
// messaging тянет @jarvis/userbots (gramjs/vk-io) — тяжёлый импорт, не нужный сценарию.
vi.mock("./messaging.js", () => ({ sendMessage: async () => ({ messageId: "1" }), configureSenders: () => undefined }));

import type { ActionCommand } from "@jarvis/protocol";
import { ocrSees, resetCapturer } from "../test-support/fake-capturer.js";
import { type FakeSidecar, useFakeSidecar } from "../test-support/fake-sidecar.js";
import { _resetFramesForTest } from "./frames.js";
import { dispatch } from "./index.js";

// Кнопка «Играть»: физика монитора (3000, 1500) 120×60 → DIP (2000, 1000) 80×40 → центр DIP (2040, 1020).
const BTN = { handle: 41, role: "button", name: "Играть", x: 3000, y: 1500, w: 120, h: 60 };
let side: FakeSidecar;

const run = async (cmd: ActionCommand) => {
  const r = await dispatch("c", cmd);
  if (!r.ok) throw new Error(`${r.error?.code}: ${r.error?.message}`);
  return r.data as Record<string, unknown>;
};

beforeEach(() => {
  _resetFramesForTest("d2p");
  resetCapturer([{ id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5 }]);
  side = useFakeSidecar();
  side.snapshot = { window: "Dota 2", pid: 500, items: [BTN], truncated: false };
  side.windows = [{ hwnd: 9, pid: 500, process: "dota2", title: "Dota 2", x: 0, y: 0, w: 3840, h: 2160, foreground: true }];
  side.at = () => null; // игра UIA-слепа под точкой → физический клик ровно в точку
  side.handlers.ocr = (a) => ocrSees([{ display: 1, text: "Играть", x: 3000, y: 1500, w: 120, h: 60 }], String(a.imageB64));
});

describe("кадры через настоящий dispatch", () => {
  it("capture (кадр 1920) → look{elements}/OCR в кадре → клик по центру bbox/строки → сайдкар жмёт DIP кнопки", async () => {
    const cap = await run({ kind: "screen.capture", monitor: "0", maxEdge: 1920, maxPixels: 3_750_000 });
    expect(cap).toMatchObject({ width: 1920, height: 1080, frameId: "d2pf1" });

    const snap = await run({ kind: "ui.snapshot", frame: "d2pf1" });
    expect(snap.frame).toBe("d2pf1");
    // физика 3000 → DIP 2000 → кадр ×0,75 = 1500; 120 → 80 DIP → 60 px кадра.
    expect((snap.items as unknown[])[0]).toMatchObject({ handle: 41, x: 1500, y: 750, w: 60, h: 30 });

    const ocr = await run({ kind: "screen.ocr", monitor: "0", frame: "d2pf1" });
    expect(ocr).toMatchObject({ frame: "d2pf1", frameId: "d2po2", width: 1920, height: 1080 }); // размер системы строк
    expect((ocr.lines as unknown[])[0]).toEqual({ text: "Играть", x: 1500, y: 750, w: 60, h: 30 });

    await run({ kind: "input.click", target: { by: "coords", x: 1530, y: 765, frame: "d2pf1" } });
    const click = side.calls.find((c) => c.op === "click");
    expect(click?.args).toMatchObject({ x: 2040, y: 1020 }); // центр кнопки в DIP — ни физика, ни кадр
  });

  it("снапшот без кадра — без bbox (физика модели не отдаётся); клик без кадра — ошибка, в сайдкар ничего", async () => {
    const snap = await run({ kind: "ui.snapshot" });
    expect((snap.items as Array<Record<string, unknown>>)[0]).not.toHaveProperty("x");
    expect(snap).not.toHaveProperty("frame");
    const r = await dispatch("c", { kind: "input.click", target: { by: "coords", x: 1530, y: 765 } });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/координаты без кадра/u);
    expect(side.mutations()).toHaveLength(0);
  });

  it("берст (skill.execute): шаг мыши несёт кадр в params → сайдкар двигает мышь в DIP кадра", async () => {
    await run({ kind: "screen.capture", monitor: "0", maxEdge: 1920, maxPixels: 3_750_000 });
    const r = await dispatch("c", {
      kind: "skill.execute",
      skillId: "adhoc",
      version: 1,
      steps: [{ action: "input.mouse", params: { op: "move", x: 1530, y: 765, frame: "d2pf1" } }],
    } as ActionCommand);
    expect(r.ok).toBe(true);
    expect(side.calls.find((c) => c.op === "mouse")?.args).toMatchObject({ op: "move", x: 2040, y: 1020 });
  });

  it("кадр прошлой загрузки клиента → «кадр устарел, пересними», клика нет", async () => {
    await run({ kind: "screen.capture", monitor: "0" });
    _resetFramesForTest("zz9"); // клиент перезапущен — сервер ещё помнит d2pf1
    const r = await dispatch("c", { kind: "input.click", target: { by: "coords", x: 10, y: 10, frame: "d2pf1" } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: "not_found" });
    expect(r.error?.message).toMatch(/устарел, пересними/u);
    expect(side.mutations()).toHaveLength(0);
  });
});

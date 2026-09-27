/**
 * W2 (пакет 0): факты рубежа на фейковом сайдкаре в реальной форме: окно под точкой — верхнее по z-order (а не
 * передний план), физика → DIP; элемент под точкой и в фокусе; мемо (один window.list на инжекцию); дедлайн → «не знаю».
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSidecar } from "../test-support/fake-sidecar.js";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { useFakeSidecar } from "../test-support/fake-sidecar.js";
import { electronState, resetElectronMock } from "../test-support/electron-mock.js";
import { FACTS_DEADLINE_MS, createInjectionFacts } from "./injection-facts.js";

let fake: FakeSidecar;
beforeEach(() => {
  fake = useFakeSidecar();
  resetElectronMock({ scale: 1.5 });
  // z-порядок сверху вниз: Блокнот маленький сверху, Telegram под ним, Chrome на переднем плане, но НИЖЕ по z (фон).
  fake.windows = [
    { hwnd: 11, pid: 101, process: "notepad", title: "Блокнот", x: 0, y: 0, w: 300, h: 300 },
    { hwnd: 22, pid: 202, process: "Telegram", title: "Telegram", x: 0, y: 0, w: 1500, h: 1200 },
    { hwnd: 33, pid: 303, process: "chrome", title: "Chrome", foreground: true, x: 0, y: 0, w: 3000, h: 1500 },
    { hwnd: 44, pid: 404, process: "Discord", title: "Discord", minimized: true, x: -32000, y: -32000, w: 160, h: 28 },
  ];
});

describe("окна", () => {
  it("windowAt: верхнее по z-order окно, чей rect в DIP содержит точку (не передний план)", async () => {
    const f = createInjectionFacts();
    expect((await f.windowAt({ x: 100, y: 100 }))?.process).toBe("notepad"); // 300 физ. = 200 DIP
    expect((await f.windowAt({ x: 250, y: 100 }))?.process).toBe("Telegram"); // за Блокнотом (200 DIP) — Telegram
    expect((await f.windowAt({ x: 1500, y: 100 }))?.process).toBe("chrome");
    expect(await f.windowAt({ x: 5000, y: 5000 })).toBeNull();
  });

  it("rawWindows — ЦЕЛИКОМ (с физическим rect), один window.list на инжекцию (мемо)", async () => {
    const f = createInjectionFacts();
    const w = await f.rawWindows();
    expect(w?.[1]).toEqual({ hwnd: 22, pid: 202, process: "Telegram", title: "Telegram", foreground: false, minimized: false, rect: { x: 0, y: 0, w: 1500, h: 1200 } });
    await f.windowAt({ x: 1, y: 1 });
    await f.windowAt({ x: 2, y: 2 });
    expect(fake.count("window.list")).toBe(1);
    expect(fake.calls[0]?.timeoutMs).toBeLessThanOrEqual(1_500);
  });

  it("сайдкар лёг → null («не знаю»), не исключение", async () => {
    fake.handlers["window.list"] = () => {
      throw new Error("sidecar exited");
    };
    const f = createInjectionFacts();
    expect(await f.rawWindows()).toBeNull();
    expect(await f.windowAt({ x: 1, y: 1 })).toBeNull();
  });
});

describe("элементы", () => {
  it("elementAt — ground.at (имя и роль реальные), focused — первая строка read.screen", async () => {
    fake.at = () => ({ handle: 41, role: "button", name: "Отправить", x: 0, y: 0, w: 80, h: 30 });
    fake.focusedText = "ControlType.Edit: Пароль [ЗАЩИЩЕНО]\nControlType.Button: Войти";
    const f = createInjectionFacts();
    expect(await f.elementAt({ x: 5, y: 5 })).toMatchObject({ handle: "41", name: "Отправить", role: "ControlType.Button" });
    expect(await f.focused()).toEqual({ role: "Edit", name: "Пароль", secret: true });
    expect(fake.calls.find((c) => c.op === "read.screen")).toMatchObject({ args: { maxChars: 300 }, timeoutMs: 2_000 });
  });

  it("общий дедлайн: истёк — факты не запрашиваются, ответ «не знаю»", async () => {
    let t = 1_000;
    const f = createInjectionFacts({ now: () => t });
    t += FACTS_DEADLINE_MS + 1;
    expect(await f.focused()).toBeNull();
    expect(await f.rawWindows()).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("ownFocused и clipboardText — без сайдкара, из Electron", () => {
    electronState.ownFocused = true;
    electronState.clipboardText = "4111 1111 1111 1111";
    const f = createInjectionFacts();
    expect(f.ownFocused()).toBe(true);
    expect(f.clipboardText()).toBe("4111 1111 1111 1111");
    expect(fake.calls).toEqual([]);
  });
});

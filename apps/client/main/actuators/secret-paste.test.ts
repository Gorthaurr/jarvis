/**
 * W2 П2 (§0): ВСТАВКА из буфера обмена — через НАСТОЯЩИЙ dispatch и рубеж; буфер обмена — мок Electron (electron-mock).
 * Реверт-проверка:
 *  • в наборе вставки только Ctrl+V (PASTE_COMBOS/keyEffect)    → Shift+Insert / Ctrl+Shift+V / Ctrl↓+V проходят;
 *  • клик «Вставить» не судится (judgeClickPaste → null)         → «клик по пункту «Вставить»»;
 *  • preflight убран из pasteText                                 → буфер обмена перезаписан картой до отказа;
 *  • метка неизвестна → пропуск                                   → «физический клик без UIA-элемента».
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import type { FakeSidecar } from "../test-support/fake-sidecar.js";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { useFakeSidecar } from "../test-support/fake-sidecar.js";
import { electronModule, electronState, resetElectronMock } from "../test-support/electron-mock.js";
import { selectionStore } from "../selection/store.js";
import { dispatch } from "./index.js";
import { resetHeldKeys } from "./input.js";
import { resetMirror } from "./handle-mirror.js";
import { resetSecretMemory } from "./secret-memory.js";
import { resetFieldCache } from "./focused-field.js";
import { InjectionDeniedError, preflightText } from "./injection-guard.js";
import { pasteText } from "./paste-text.js";

let fake: FakeSidecar;
let n = 0;
const run = (cmd: ActionCommand) => dispatch(`p${(n += 1)}`, cmd);
const ops = () => fake.mutations().map((c) => c.op);
const CARD = "4276 1600 1234 5675";
const PASTE_ITEM = { handle: 31, role: "menuitem", name: "Вставить", x: 10, y: 10, w: 120, h: 24 };
const SEND = { handle: 41, role: "button", name: "Отправить", x: 300, y: 300, w: 80, h: 30 };

const prevObserve = process.env.JARVIS_FUSED_OBSERVE;
beforeAll(() => {
  process.env.JARVIS_FUSED_OBSERVE = "0";
});
afterAll(() => {
  if (prevObserve === undefined) delete process.env.JARVIS_FUSED_OBSERVE;
  else process.env.JARVIS_FUSED_OBSERVE = prevObserve;
});

beforeEach(() => {
  fake = useFakeSidecar();
  fake.snapshot = { window: "Заказ — Магазин", pid: 500, items: [PASTE_ITEM, SEND], truncated: false };
  fake.focusedText = "ControlType.Edit: Комментарий [ПУСТО]";
  resetElectronMock({ clipboardText: CARD });
  resetHeldKeys();
  resetMirror();
  resetSecretMemory();
  resetFieldCache();
  selectionStore.setDrawing(false);
});

describe("карта в буфере обмена", () => {
  it.each(["Ctrl+V", "Ctrl+Shift+V", "Shift+Insert", "v+ctrl"])("«%s» — denied, ни одного нажатия", async (combo) => {
    const r = await run({ kind: "input.key", combo });
    expect(r.error?.code).toBe("denied");
    expect(r.data).toEqual({ secretGuard: "paste" });
    expect(ops()).toEqual([]);
  });

  it("вставка, собранная удержанием: Ctrl↓, затем «V» — denied на «V»", async () => {
    await run({ kind: "input.key", combo: "Ctrl", mode: "down" });
    expect((await run({ kind: "input.key", combo: "v" })).data).toEqual({ secretGuard: "paste" });
    expect(fake.mutations().map((c) => c.args.combo)).toEqual(["Ctrl"]);
  });

  it("клик по пункту «Вставить» (UIA, handle из снапшота) — denied; клик по «Отправить» — уходит", async () => {
    await run({ kind: "ui.snapshot" });
    const r = await run({ kind: "input.click", target: { by: "handle", handle: "31" } });
    expect(r.error?.code).toBe("denied");
    expect(r.data).toEqual({ secretGuard: "paste" });
    expect((await run({ kind: "ui.invoke", target: { by: "handle", handle: "31" }, pattern: "invoke" })).error?.code).toBe("denied");
    expect((await run({ kind: "input.click", target: { by: "handle", handle: "41" } })).ok).toBe(true);
    expect(ops()).toEqual(["invoke"]);
  });

  it("физический клик по точке без UIA-элемента — denied (могла быть вставка); над «Отправить» — уходит", async () => {
    fake.at = () => null; // canvas/игра: ground.at бросает
    const r = await run({ kind: "input.click", target: { by: "coords", x: 50, y: 50, space: "screen" }, method: "physical" });
    expect(r.data).toEqual({ secretGuard: "paste" });
    fake.at = () => SEND;
    expect((await run({ kind: "input.click", target: { by: "coords", x: 310, y: 310, space: "screen" }, method: "physical" })).ok).toBe(true);
    expect(ops()).toEqual(["click"]);
  });

  it("в буфере обмена нет карты — клик не судится вовсе: ни одного ground.at от рубежа", async () => {
    electronState.clipboardText = "просто текст";
    expect((await run({ kind: "input.click", target: { by: "coords", x: 50, y: 50, space: "screen" }, method: "physical" })).ok).toBe(true);
    expect(fake.count("ground.at")).toBe(0);
  });
});

describe("поле-секрет и обычная вставка", () => {
  it("буфер обмена «hunter2» (не карта) + Ctrl+V в поле [ЗАЩИЩЕНО] — denied; в обычное поле — уходит", async () => {
    electronState.clipboardText = "hunter2";
    fake.focusedText = "ControlType.Edit: Пароль [ЗАЩИЩЕНО]";
    expect((await run({ kind: "input.key", combo: "Ctrl+V" })).data).toEqual({ secretGuard: "paste" });
    fake.focusedText = "ControlType.Edit: Комментарий [ПУСТО]";
    expect((await run({ kind: "input.key", combo: "Ctrl+V" })).ok).toBe(true);
    expect(fake.mutations().map((c) => c.args.combo)).toEqual(["Ctrl+V"]);
  });
});

describe("pasteText (длинный текст act): предпроверка ДО записи в буфер обмена", () => {
  it("текст > 80 символов с картой — отказ §0, в буфер обмена НЕ записано ничего (история Win+V не увидит карту)", async () => {
    electronState.clipboardText = "скопировал владелец";
    const writes = vi.spyOn(electronModule.clipboard, "writeText");
    const text = `Оплата заказа: ${CARD}, ${"подробности ".repeat(8)}`;
    expect(text.length).toBeGreaterThan(80);
    try {
      await expect(pasteText(text)).rejects.toBeInstanceOf(InjectionDeniedError);
      expect(writes).not.toHaveBeenCalled(); // без предпроверки: запись карты → отказ на Ctrl+V → возврат буфера
    } finally {
      writes.mockRestore();
    }
    expect(electronState.clipboardText).toBe("скопировал владелец");
    expect(ops()).toEqual([]);
  });

  it("текст в поле [ЗАЩИЩЕНО] — отказ до подмены буфера; обычный длинный текст — вставка, буфер возвращён", async () => {
    electronState.clipboardText = "скопировал владелец";
    fake.focusedText = "ControlType.Edit: Пароль [ЗАЩИЩЕНО]";
    await expect(pasteText("x".repeat(100))).rejects.toMatchObject({ judge: "secret", actionCode: "denied" });
    expect(electronState.clipboardText).toBe("скопировал владелец");
    fake.focusedText = "ControlType.Edit: Комментарий [ПУСТО]";
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const p = pasteText("длинный комментарий ".repeat(6));
      await vi.runAllTimersAsync();
      expect(await p).toBe("paste");
    } finally {
      vi.useRealTimers();
    }
    expect(electronState.clipboardText).toBe("скопировал владелец");
    expect(fake.mutations().map((c) => c.args.combo)).toEqual(["Ctrl+V"]);
    expect(fake.count("read.screen")).toBe(2); // отказ + (предпроверка ≡ Ctrl+V той же операции — один read.screen)
  });
});

describe("вердикт предпроверки переиспользуется только для ТОГО ЖЕ текста", () => {
  it("предпроверка «привет» (поле обычное) → фокус сам ушёл в пароль → печать ДРУГОГО текста судится заново — denied", async () => {
    electronState.clipboardText = "";
    await preflightText("привет");
    fake.focusedText = "ControlType.Edit: Пароль [ЗАЩИЩЕНО]"; // диалог пароля выскочил сам (без событий ввода)
    expect((await run({ kind: "input.type", text: "hunter2" })).data).toEqual({ secretGuard: "field" });
    expect(fake.count("read.screen")).toBe(2);
  });

  it("кусок того же текста — без второго read.screen (предпроверка ≡ первый кусок)", async () => {
    await preflightText("привет, мир");
    expect((await run({ kind: "input.type", text: "привет" })).ok).toBe(true);
    expect(fake.count("read.screen")).toBe(1);
  });
});

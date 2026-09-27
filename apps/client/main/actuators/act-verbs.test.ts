/**
 * W2 (П4): новые руки act через НАСТОЯЩИЙ `dispatch` клиента и фейковый сайдкар в РЕАЛЬНОЙ форме ответов (Ipc.cs:
 * снапшот с handle числом и короткой ролью, ground.at плоский «ControlType.X», bbox — физика). Смотрим, ЧТО ушло
 * в сайдкар — это и есть то, что нажалось бы на ПК владельца.
 *  - triple → click count 3; middle → button middle; hover → mouse move в центр bbox (физика → DIP);
 *  - scroll → mouse wheel В ЭЛЕМЕНТЕ с dy (обход G-17: ни одного UIA scroll); drag → mouse drag к `to`;
 *  - clear на Edit → UIA setValue "" (или Ctrl+A → Delete, если паттерна нет); clear на ListItem → ни одной мутации;
 *  - enter:true → Enter ПОСЛЕ печати.
 * Реверт-проверка: убери проверку роли в clearPlan (act-do-text.ts) — падает «clear на ListItem»; верни колесо на UIA
 * scroll / убери dy — падает «scroll»; убери pressKey Enter — падает «enter».
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import type { FakeSidecar } from "../test-support/fake-sidecar.js";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { resetMirror } from "./handle-mirror.js";
import { resetHeldKeys } from "./input.js";
import { selectionStore } from "../selection/store.js";
import { dispatch } from "./index.js";

let fake: FakeSidecar;
const act = (over: Partial<Extract<ActionCommand, { kind: "gui.act" }>>) => dispatch("c1", { kind: "gui.act", observe: false, origin: "user", ...over } as ActionCommand);
const muts = () => fake.mutations().map((c) => ({ ...c.args, op: c.op }));

beforeEach(() => {
  fake = useFakeSidecar();
  // Telegram: bbox — ФИЗИЧЕСКИЕ пиксели при масштабе 1,5 (DIP = физика / 1,5).
  fake.snapshot = {
    window: "Telegram",
    pid: 4242,
    truncated: false,
    items: [
      { handle: 41, role: "edit", name: "Поиск", x: 300, y: 150, w: 600, h: 60, value: "старое" },
      { handle: 42, role: "listitem", name: "Катя", x: 300, y: 300, w: 600, h: 90 },
      { handle: 43, role: "list", name: "Чаты", x: 300, y: 240, w: 600, h: 900 },
      { handle: 44, role: "button", name: "Архив", x: 1200, y: 150, w: 90, h: 60 },
      { handle: 45, role: "combobox", name: "Город", x: 300, y: 1200, w: 300, h: 60, value: "Москва" },
      { handle: 46, role: "combobox", name: "Режим", x: 700, y: 1200, w: 300, h: 60 },
    ],
  };
  fake.windows = [{ hwnd: 7, pid: 4242, process: "Notepad", title: "Telegram", foreground: true, x: 0, y: 0, w: 1920, h: 1080 }];
  resetElectronMock({ scale: 1.5 });
  resetMirror();
  resetHeldKeys();
  selectionStore.setDrawing(false);
});

describe("глаголы указателя", () => {
  it("triple → физический клик ×3 по элементу; middle → средняя кнопка", async () => {
    expect((await act({ target: "Катя", do: "triple" })).ok).toBe(true);
    expect(muts()).toEqual([expect.objectContaining({ op: "click", handle: "42", count: 3, button: "left" })]);
    fake.calls.length = 0;
    expect((await act({ target: "Архив", do: "middle" })).ok).toBe(true);
    expect(muts()).toEqual([expect.objectContaining({ op: "click", handle: "44", button: "middle", count: 1 })]);
  });

  it("hover → mouse move в центр bbox, переведённый из физики в DIP", async () => {
    const r = await act({ target: "Архив", do: "hover" });
    expect(r.ok).toBe(true);
    // центр физ. bbox (1245, 180) / 1,5 = (830, 120) DIP
    expect(fake.mutations().map((c) => c.op)).toEqual(["mouse"]);
    expect(fake.mutations()[0]?.args).toMatchObject({ op: "move", x: 830, y: 120 });
  });

  it("scroll → колесо В ЭЛЕМЕНТЕ списка с dy (обход G-17): ни одного UIA invoke scroll", async () => {
    const r = await act({ target: { text: "Чаты", role: "list" }, do: "scroll", dy: -5 });
    expect(r.ok).toBe(true);
    expect(fake.mutations().map((c) => c.args)).toEqual([expect.objectContaining({ op: "wheel", dy: -5, x: 400, y: 460 })]);
    expect(fake.calls.some((c) => c.op === "invoke")).toBe(false);
  });

  it("drag → mouse drag из цели к `to` (вторая цель — той же лестницей)", async () => {
    const r = await act({ target: "Катя", do: "drag", to: "Архив" });
    expect(r.ok).toBe(true);
    expect(fake.mutations().map((c) => c.args)).toEqual([expect.objectContaining({ op: "drag", x: 400, y: 230, toX: 830, toY: 120 })]);
  });

  it("точка без UIA-элемента и без bbox у handle-цели → честная ошибка ДО действия", async () => {
    const r = await act({ target: { handle: "999" }, do: "hover" });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/неизвестно, где элемент/u);
    expect(fake.mutations()).toEqual([]);
  });
});

describe("clear / enter", () => {
  it("clear на Edit → UIA setValue \"\" до клика, затем печать; Enter не жмётся без enter:true", async () => {
    const r = await act({ target: "Поиск", do: "type", text: "кот", clear: true });
    expect(r.ok).toBe(true);
    const m = fake.mutations();
    expect(m[0]).toMatchObject({ op: "invoke", args: { handle: "41", pattern: "setValue", value: "" } });
    expect(m.map((c) => c.op)).toEqual(["invoke", "invoke", "type"]); // очистка → бесшумный клик в поле → печать
    expect(m.some((c) => c.op === "key")).toBe(false);
  });

  it("clear на Edit без ValuePattern → после клика Ctrl+A → Delete, потом печать", async () => {
    fake.handlers.invoke = (a) => {
      if (a.pattern === "setValue") throw new Error("Элемент не поддерживает ValuePattern");
      return { success: true };
    };
    const r = await act({ target: "Поиск", do: "type", text: "кот", clear: true });
    expect(r.ok).toBe(true);
    const keys = fake.mutations().filter((c) => c.op === "key").map((c) => c.args.combo);
    expect(keys).toEqual(["Ctrl+A", "Delete"]);
    const ops = fake.mutations().map((c) => c.op);
    expect(ops.indexOf("key")).toBeLessThan(ops.indexOf("type"));
  });

  it("clear на ListItem → отказ ДО любого ввода: ни одной мутации (ни клика, ни клавиши)", async () => {
    const r = await act({ target: "Катя", do: "type", text: "x", clear: true });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/очищаю только поля ввода/u);
    expect(fake.mutations()).toEqual([]);
  });

  it("clear на ComboBox: только UIA setValue; не принят (только чтение) или список без значения → ни одной клавиши и клика", async () => {
    expect((await act({ target: "Город", do: "type", text: "Тверь", clear: true })).ok).toBe(true);
    expect(fake.mutations()[0]).toMatchObject({ op: "invoke", args: { handle: "45", pattern: "setValue", value: "" } });
    fake.calls.length = 0;
    fake.handlers.invoke = (a) => {
      if (a.pattern === "setValue") throw new Error("ElementNotEnabled: только для чтения");
      return { success: true };
    };
    const ro = await act({ target: "Город", do: "type", text: "Тверь", clear: true });
    expect(ro.ok).toBe(false);
    expect(fake.mutations().filter((c) => c.op !== "invoke")).toEqual([]);
    fake.calls.length = 0;
    const nv = await act({ target: "Режим", do: "type", text: "x", clear: true });
    expect(nv.ok).toBe(false);
    expect(fake.mutations()).toEqual([]);
  });

  it("enter:true → Enter ПОСЛЕ печати (через рубеж, одной клавишей)", async () => {
    const r = await act({ target: "Поиск", do: "type", text: "кот", enter: true });
    expect(r.ok).toBe(true);
    const ops = fake.mutations().map((c) => (c.op === "key" ? `key:${String(c.args.combo)}` : c.op));
    expect(ops).toEqual(["invoke", "type", "key:Enter"]);
    expect((r.data as { did?: string }).did).toMatch(/нажал Enter/u);
  });

  it("печать ушла, Enter упал → исход неизвестен (stepActionInjected), без повтора", async () => {
    fake.handlers.key = () => {
      throw new Error("sidecar упал");
    };
    const r = await act({ target: "Поиск", do: "type", text: "кот", enter: true });
    expect(r.ok).toBe(false);
    expect(r.stepActionInjected).toBe(true);
    expect(fake.count("type")).toBe(1);
  });
});

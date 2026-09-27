/**
 * W2 П2 (§0): ЛУНА ПО СКЛЕЙКЕ — карта, набранная кусками (два type, поцифровые клавиши, шаги батча), и сбросы эпохи
 * набранного, которые не дают ложных отказов. Всё — через НАСТОЯЩИЙ dispatch и рубеж; сайдкар — фейк в реальной форме.
 * Реверт-проверка:
 *  • Луна на каждый вызов отдельно (cardInTyped без inputBuffer.digits)  → «два type», «поцифровые key», «батч»;
 *  • буфер не сбрасывается по Enter (keyEffect Enter → keep)             → «телефон, Enter, цифры в другом поле»;
 *  • сброс на правке внутри поля (End → reset)                           → «End посреди номера»;
 *  • сброс на любой смене фокуса окна (без сравнения hwnd)               → «тот же hwnd — склейка живёт».
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import type { FakeSidecar } from "../test-support/fake-sidecar.js";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { selectionStore } from "../selection/store.js";
import { dispatch } from "./index.js";
import { resetHeldKeys } from "./input.js";
import { resetMirror } from "./handle-mirror.js";
import { BUFFER_IDLE_MS, resetSecretMemory } from "./secret-memory.js";
import { resetFieldCache } from "./focused-field.js";
import { _resetJarvisInputForTest, noteOwnerInput } from "./input-mark.js";

let fake: FakeSidecar;
let n = 0;
const run = (cmd: ActionCommand) => dispatch(`b${(n += 1)}`, cmd);
const typed = () => fake.mutations().filter((c) => c.op === "type").map((c) => c.args.text);
const type = (text: string) => run({ kind: "input.type", text });

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
  fake.focusedText = "ControlType.Edit: Номер [ПУСТО]";
  fake.windows = [
    { hwnd: 11, pid: 101, process: "notepad", title: "Блокнот", foreground: true, x: 0, y: 0, w: 800, h: 600 },
    { hwnd: 22, pid: 202, process: "Telegram", title: "Telegram", x: 0, y: 0, w: 800, h: 600 },
  ];
  resetElectronMock();
  resetHeldKeys();
  resetMirror();
  resetSecretMemory();
  resetFieldCache();
  _resetJarvisInputForTest();
  selectionStore.setDrawing(false);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("карта по кускам", () => {
  it("type «4276 1600» + type « 1234 5675» — второй denied (Луна по склейке), первый ушёл", async () => {
    expect((await type("4276 1600")).ok).toBe(true);
    const r = await type(" 1234 5675");
    expect(r.error?.code).toBe("denied");
    expect(r.data).toEqual({ secretGuard: "card" });
    expect(typed()).toEqual(["4276 1600"]);
  });

  it("поцифровые key: 15 цифр уходят, последняя (16-я, замыкающая карту) — denied", async () => {
    const digits = "4276160012000569".split(""); // ни один префикс 13–15 цифр не проходит Луна — отказ ровно на 16-й
    for (const d of digits.slice(0, -1)) expect((await run({ kind: "input.key", combo: d })).ok).toBe(true);
    const r = await run({ kind: "input.key", combo: digits.at(-1)! });
    expect(r.data).toEqual({ secretGuard: "card" });
    expect(fake.mutations()).toHaveLength(15);
  });

  it("шаги батча (skill.execute: input_batch) — последний denied, в сайдкар ушёл только первый кусок", async () => {
    const r = await run({
      kind: "skill.execute",
      skillId: "batch",
      version: 1,
      steps: [
        // retries не заданы — как у input_batch сервера (раннер ретраит 2 раза: повтор судится так же и не проходит)
        { action: "input.type", params: { text: "4276 1600" } },
        { action: "input.type", params: { text: " 1234 5675" } },
      ],
      origin: "user",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/§0/u);
    expect(typed()).toEqual(["4276 1600"]);
  });

  it("правка внутри поля (End, стрелки) не рвёт склейку: «4276 1600 1234 567» + End + «5» — denied", async () => {
    await type("4276 1600 1234 567");
    await run({ kind: "input.key", combo: "End" });
    expect((await type("5")).data).toEqual({ secretGuard: "card" });
  });

  it("забой стирает и из буфера: «4276 1600 1234 5670» + Backspace + «5» — denied (в поле …5675)", async () => {
    expect((await type("4276 1600 1234 5670")).ok).toBe(true); // Луна не проходит
    expect((await run({ kind: "input.key", combo: "Backspace" })).ok).toBe(true);
    expect((await type("5")).data).toEqual({ secretGuard: "card" }); // без забоя в буфере: …56705 — не карта
  });

  it("забой, после которого в поле остаётся карта («…56759» − «9»), — denied на Backspace", async () => {
    expect((await type("4276 1600 1234 56759")).ok).toBe(true); // 17 цифр — Луна не проходит
    const r = await run({ kind: "input.key", combo: "Backspace" });
    expect(r.data).toEqual({ secretGuard: "card" });
    expect(fake.mutations().map((c) => c.op)).toEqual(["type"]);
  });
});

describe("сбросы эпохи — без ложных отказов", () => {
  it("телефон «8 800 555 35 35», Enter, затем цифры в ДРУГОМ поле — без ложного отказа", async () => {
    expect((await type("8 800 555 35 35")).ok).toBe(true);
    expect((await run({ kind: "input.key", combo: "Enter" })).ok).toBe(true);
    expect((await type("12 08")).ok).toBe(true); // без сброса: 8800555353512 08 — проходит Луна → ложный отказ
    expect(typed()).toEqual(["8 800 555 35 35", "12 08"]);
  });

  it("Tab между полями — тоже новая эпоха", async () => {
    await type("8 800 555 35 35");
    await run({ kind: "input.key", combo: "Tab" });
    expect((await type("12 08")).ok).toBe(true);
  });

  it("ввод владельца (сайдкар: живой ввод) между кусками — новая эпоха", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    await type("8 800 555 35 35");
    vi.setSystemTime(1_000_500);
    noteOwnerInput();
    vi.setSystemTime(1_001_000);
    expect((await type("12 08")).ok).toBe(true);
  });

  it(`пауза > ${BUFFER_IDLE_MS / 1000} с — новая эпоха; без паузы склейка живёт`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    await type("8 800 555 35 35");
    vi.setSystemTime(2_000_000 + BUFFER_IDLE_MS + 1);
    expect((await type("12 08")).ok).toBe(true);
    vi.setSystemTime(2_100_000);
    await type("8 800 555 35 35");
    expect((await type("12 08")).data).toEqual({ secretGuard: "card" });
  });

  it("window.focus: ДРУГОЕ окно — новая эпоха; ТО ЖЕ окно (act с тем же app) — склейка живёт", async () => {
    await run({ kind: "window.focus", hwnd: 11 });
    await type("4276 1600");
    await run({ kind: "window.focus", hwnd: 11 });
    expect((await type(" 1234 5675")).data).toEqual({ secretGuard: "card" });
    await run({ kind: "input.key", combo: "Enter" });
    expect((await type("8 800 555 35 35")).ok).toBe(true);
    await run({ kind: "window.focus", hwnd: 22 });
    expect((await type("12 08")).ok).toBe(true); // без смены эпохи: 8800555353512 08 — Луна → ложный отказ
  });

  it("клик (invoke по handle) — новая эпоха", async () => {
    fake.snapshot = { window: "Форма", pid: 101, items: [{ handle: 5, role: "edit", name: "Сумма", x: 0, y: 0, w: 100, h: 20 }], truncated: false };
    await type("8 800 555 35 35");
    await run({ kind: "ui.snapshot" });
    await run({ kind: "input.click", target: { by: "handle", handle: "5" } });
    expect((await type("12 08")).ok).toBe(true);
  });
});

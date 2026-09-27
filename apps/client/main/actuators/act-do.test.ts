/**
 * W4 «Руки» / W2 (пакет 0, разрез act.test.ts): ДЕЙСТВИЕ act над найденной целью. Реальный act(), листья —
 * test-support/act-mocks (у input.js есть и mouse). Владелец — П4 (глаголы указателя, clear/enter).
 *
 * Что охраняется: ПОВТОР ТОЛЬКО ЕСЛИ НИЧЕГО НЕ УШЛО (invoke бросил ДО действия → один физический клик; таймаут invoke,
 * печать упала после клика → исход неизвестен, без второго клика); длинный текст — вставкой; печать без цели — в фокус;
 * W2 (П4): неверная форма новых глаголов — отказ ДО поиска и ввода; координаты авто-макроса — только у голого жеста
 * (исполнение глаголов на настоящем dispatch и фейковом сайдкаре — act-verbs.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const st = await vi.hoisted(async () => (await import("../test-support/act-mocks.js")).createActState());
vi.mock("./ground.js", async () => (await import("../test-support/act-mocks.js")).actMocks.ground(st));
vi.mock("./screen.js", async () => (await import("../test-support/act-mocks.js")).actMocks.screen());
vi.mock("./sensors-cheap.js", async () => (await import("../test-support/act-mocks.js")).actMocks.sensors(st));
vi.mock("./input.js", async () => (await import("../test-support/act-mocks.js")).actMocks.input(st));
vi.mock("./paste-text.js", async () => (await import("../test-support/act-mocks.js")).actMocks.paste(st));
vi.mock("./observe.js", async () => (await import("../test-support/act-mocks.js")).actMocks.observe(st));
vi.mock("./windows.js", async () => (await import("../test-support/act-mocks.js")).actMocks.windows(st));
vi.mock("./apps.js", async () => (await import("../test-support/act-mocks.js")).actMocks.apps(st));
// Интеграция W2 (стык П4×П1): ранняя проверка клавиш act (enter:true, «\n») — НАСТОЯЩИЙ рубеж; его факты — фейковый
// сайдкар в реальной форме. Без окон процесс неизвестен → Enter честно отклонялся бы до печати.
vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { resetActState } from "../test-support/act-mocks.js";
import { useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { NOTEPAD, front } from "../test-support/rubezh-fixtures.js";
import { act } from "./act.js";
import { ActPartialError } from "./act-do.js";

const OPTS = { restoreCursor: true };
beforeEach(() => {
  resetActState(st);
  resetElectronMock();
  useFakeSidecar().windows = front(NOTEPAD); // обычная программа спереди: Enter после печати — не коммит
});

const nothingSent = (): void => {
  for (const f of [st.invoke, st.click, st.typeText, st.pressKey, st.mouse, st.pasteText]) expect(f).not.toHaveBeenCalled();
};

describe("act — повтор только если ничего не ушло", () => {
  it("invoke бросил ДО действия → ОДИН физический клик по тому же handle; verify провалился → verified:failed без второго клика", async () => {
    st.invoke.mockRejectedValueOnce(new Error("InvokePattern не поддержан"));
    st.wait = async () => ({ met: false, elapsedMs: 4000, polls: 5, detail: "текста нет" });
    const r = await act({ kind: "gui.act", target: "Отправить", verify: { text: "Отправлено" } }, OPTS);
    expect(st.invoke).toHaveBeenCalledTimes(1);
    expect(st.click).toHaveBeenCalledTimes(1);
    expect(st.click.mock.calls[0]?.[0]).toEqual({ by: "handle", handle: "11" });
    expect(r.verified).toBe("failed");
    expect(r.did).toMatch(/физический клик.*не поддержан/u);
  });

  it("H-A1: invoke по handle не поддержан → физический фолбэк кликает в найденную ТОЧКУ, а не в центр элемента", async () => {
    st.invoke.mockRejectedValueOnce(new Error("не поддерживает InvokePattern"));
    st.click.mockResolvedValue({ screenX: 500, screenY: 400 });
    await act({ kind: "gui.act", target: { x: 500, y: 400, space: "screen" } }, OPTS);
    expect(st.click).toHaveBeenCalledTimes(1);
    expect(st.click.mock.calls[0]?.[0]).toEqual({ by: "coords", x: 500, y: 400, space: "screen" });
  });

  it("H-T2: invoke упал по ТАЙМАУТУ → исход неизвестен (ActPartialError), второго физического клика нет", async () => {
    st.invoke.mockRejectedValueOnce(new Error("sidecar timeout op=invoke"));
    await expect(act({ kind: "gui.act", target: "Отправить" }, OPTS)).rejects.toBeInstanceOf(ActPartialError);
    expect(st.click).not.toHaveBeenCalled();
  });

  it("do:type — клик в поле ушёл, печать упала → ActPartialError (исход неизвестен), без повтора клика", async () => {
    st.typeText.mockRejectedValueOnce(new Error("сайдкар лёг"));
    const p = act({ kind: "gui.act", target: { text: "Поиск", role: "Edit" }, do: "type", text: "кот" }, OPTS);
    await expect(p).rejects.toBeInstanceOf(ActPartialError);
    expect(st.click).toHaveBeenCalledTimes(1);
  });
});

describe("act — глаголы", () => {
  it("do:type → сначала клик (silent по handle), затем печать; do:right → физический правый клик", async () => {
    await act({ kind: "gui.act", target: { text: "Поиск", role: "Edit" }, do: "type", text: "кот" }, OPTS);
    expect(st.click).toHaveBeenCalledWith({ by: "handle", handle: "13" }, "silent", true, undefined);
    expect(st.typeText).toHaveBeenCalledWith("кот");
    st.click.mockClear();
    await act({ kind: "gui.act", target: "Отправить", do: "right" }, OPTS);
    expect(st.click).toHaveBeenCalledWith({ by: "handle", handle: "11" }, "physical", true, { button: "right" });
  });

  it("H-T1: длинный текст вставляется (paste), а не печатается посимвольно", async () => {
    const long = "а".repeat(300);
    st.click.mockResolvedValue({ screenX: 1, screenY: 1 });
    await act({ kind: "gui.act", target: { text: "Поиск", role: "Edit" }, do: "type", text: long }, OPTS);
    expect(st.pasteText).toHaveBeenCalledWith(long);
    expect(st.typeText).not.toHaveBeenCalled();
  });

  it("do:type БЕЗ цели → печать в поле с фокусом: ни поиска, ни клика; без text — ошибка; прочие глаголы без цели — ошибка", async () => {
    const r = await act({ kind: "gui.act", app: "Discord", do: "type", text: "general" }, OPTS);
    expect(st.snapshotCalls).toBe(0);
    expect(st.click).not.toHaveBeenCalled();
    expect(st.typeText).toHaveBeenCalledWith("general");
    expect(r.did).toMatch(/в поле с фокусом/u);
    await expect(act({ kind: "gui.act", do: "type" }, OPTS)).rejects.toThrow(/без text/u);
    await expect(act({ kind: "gui.act", do: "click" }, OPTS)).rejects.toThrow(/без target/u);
  });

  it("do:type без цели: печать упала посреди → ActPartialError (часть могла уйти), не молчаливый провал", async () => {
    st.typeText.mockRejectedValueOnce(new Error("сайдкар лёг"));
    await expect(act({ kind: "gui.act", do: "type", text: "привет" }, OPTS)).rejects.toBeInstanceOf(ActPartialError);
  });
});

describe("W2 (П4): форма аргументов новых глаголов — ошибка ДО поиска и любого ввода", () => {
  it.each([
    ["clear не с type", { target: "Поиск", do: "click", clear: true }, /только с do:"type"/u],
    ["enter не с type", { do: "key", combo: "a", enter: true }, /только с do:"type"/u],
    ["clear без цели (роль не проверить)", { do: "type", text: "x", clear: true }, /clear:true без target/u],
    ["to не с drag", { target: "A", to: "B" }, /только с do:"drag"/u],
    ["drag без to", { target: "A", do: "drag" }, /без to/u],
    ["dy не со scroll", { target: "A", dy: 3 }, /только с do:"scroll"/u],
    ["scroll без dy/dx", { target: "A", do: "scroll" }, /без dy/u],
    ["scroll дробными тиками", { target: "A", do: "scroll", dy: 1.5 }, /целые тики/u],
    ["hover без цели", { do: "hover" }, /без target/u],
  ] as const)("%s → отказ, ничего не нажато", async (_n, over, re) => {
    await expect(act({ kind: "gui.act", ...over } as Parameters<typeof act>[0], OPTS)).rejects.toThrow(re);
    expect(st.snapshotCalls).toBe(0);
    nothingSent();
  });
});

describe("W2 (П4): координаты для авто-макроса §8 — только у «голого» жеста", () => {
  it("type с enter и глаголы указателя НЕ отдают screenX (реплей повторил бы их обычным кликом); голый type — отдаёт", async () => {
    st.click.mockResolvedValue({ screenX: 5, screenY: 6 });
    const plain = await act({ kind: "gui.act", target: { text: "Поиск", role: "Edit" }, do: "type", text: "кот" }, OPTS);
    expect(plain.screenX).toBe(5);
    const withEnter = await act({ kind: "gui.act", target: { text: "Поиск", role: "Edit" }, do: "type", text: "кот", enter: true }, OPTS);
    expect(withEnter.screenX).toBeUndefined();
    expect(st.pressKey).toHaveBeenLastCalledWith("Enter");
    const triple = await act({ kind: "gui.act", target: "Отправить всем", do: "triple" }, OPTS);
    expect(triple.screenX).toBeUndefined();
    expect(st.click).toHaveBeenLastCalledWith({ by: "handle", handle: "12" }, "physical", true, { count: 3 });
    expect(triple.did).toMatch(/тройной клик/u);
  });
});

/**
 * ПРОВОДКА наблюдения-дельты: снимок «до» реально доезжает до observeAfterAction, и платим за него
 * ровно там, где наблюдение будет.
 *
 * Зачем поведенческий тест (адверс-ревью 2026-09-01, HIGH): дельта была покрыта только ЧИСТЫМИ
 * функциями, и мутант «убрать `before: beforeUi` из case input.click» оставлял оба набора зелёными,
 * молча возвращая наблюдение в старый режим «описание окна». Ровно тот класс, на котором проект уже
 * обжигался (мёртвый gateStoppedRound, мёртвый uncertainCalls.add, мёртвый break в selFor).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";

const FP = { title: "Окно", lines: ["Button: Играть"] };

const captureUiFingerprint = vi.fn(async () => FP);
const observeAfterAction = vi.fn(async (_o?: unknown) => undefined);

vi.mock("./observe.js", () => ({ captureUiFingerprint, observeAfterAction }));
// Листья, до которых доходит dispatch наблюдающих команд, — заглушены: проверяем ПРОВОДКУ.
vi.mock("./input.js", () => ({
  click: vi.fn(async () => ({ screenX: 10, screenY: 20 })),
  typeText: vi.fn(async () => undefined),
  pressKey: vi.fn(async () => undefined),
  mouse: vi.fn(async () => undefined),
}));
vi.mock("./ground.js", () => ({
  invoke: vi.fn(async () => ({ ok: true })),
  uiSnapshot: vi.fn(async () => ({ items: [] })),
  readContext: vi.fn(async () => ""),
  groundElement: vi.fn(async () => null),
}));
vi.mock("electron", () => ({
  powerMonitor: { getSystemIdleTime: () => 999 },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } }) },
}));

const { dispatch, willObserve } = await import("./index.js");

beforeEach(() => {
  captureUiFingerprint.mockClear();
  observeAfterAction.mockClear();
});

/** Аргумент, с которым звали наблюдение. */
const observedWith = () => observeAfterAction.mock.calls[0]?.[0] as { before?: unknown } | undefined;

describe("снимок ДО доезжает до наблюдения", () => {
  it("input.click: наблюдение получает ИМЕННО снимок, снятый до действия", async () => {
    await dispatch("c1", { kind: "input.click", target: { by: "coords", x: 10, y: 20 } } as ActionCommand);
    expect(captureUiFingerprint).toHaveBeenCalledTimes(1);
    expect(observedWith()?.before).toBe(FP);
  });

  it("input.type: то же самое (ввод текста меняет значение поля — дельта это и показывает)", async () => {
    await dispatch("c2", { kind: "input.type", text: "привет" } as ActionCommand);
    expect(observedWith()?.before).toBe(FP);
  });

  it("ui.invoke: то же самое", async () => {
    await dispatch("c3", { kind: "ui.invoke", target: { by: "handle", handle: "h1" }, pattern: "invoke" } as ActionCommand);
    expect(observedWith()?.before).toBe(FP);
  });
});

describe("за снимок не платим там, где наблюдения не будет", () => {
  it("input.key mode=down (середина жеста, игровое удержание) — снимка нет", async () => {
    await dispatch("c4", { kind: "input.key", combo: "w", mode: "down" } as ActionCommand);
    expect(captureUiFingerprint).not.toHaveBeenCalled();
    expect(observeAfterAction).not.toHaveBeenCalled();
  });

  it("input.mouse op=move — снимка нет", async () => {
    await dispatch("c5", { kind: "input.mouse", op: "move", x: 5, y: 5 } as ActionCommand);
    expect(captureUiFingerprint).not.toHaveBeenCalled();
  });

  it("input.key press — снимок есть (жест завершённый)", async () => {
    await dispatch("c6", { kind: "input.key", combo: "enter" } as ActionCommand);
    expect(captureUiFingerprint).toHaveBeenCalledTimes(1);
    expect(observedWith()?.before).toBe(FP);
  });
});

describe("willObserve — один источник правды", () => {
  it("совпадает с реальными условиями наблюдения", () => {
    expect(willObserve({ kind: "input.key", combo: "w", mode: "down" } as ActionCommand)).toBe(false);
    expect(willObserve({ kind: "input.key", combo: "w", mode: "up" } as ActionCommand)).toBe(false);
    expect(willObserve({ kind: "input.key", combo: "enter" } as ActionCommand)).toBe(true);
    expect(willObserve({ kind: "input.mouse", op: "move" } as ActionCommand)).toBe(false);
    expect(willObserve({ kind: "input.mouse", op: "drag" } as ActionCommand)).toBe(true);
    expect(willObserve({ kind: "input.click", target: { by: "coords", x: 1, y: 1 } } as ActionCommand)).toBe(true);
    expect(willObserve({ kind: "app.launch", app: "steam" } as ActionCommand)).toBe(false);
  });
});

/**
 * 🔴 Адверс-ревью 2026-09-02 (MED, доказано мутацией): проводка точки действия в снимок «до» не была
 * покрыта НИЧЕМ — мутант `captureUiFingerprint(plannedClickPoint(cmd))` → `captureUiFingerprint()`
 * оставлял 452 теста зелёными и tsc чистым, ПОЛНОСТЬЮ выключая сравнение «до/после» на слепом окне
 * (снимок всегда undefined → вечный weak).
 */
describe("точка действия доезжает до снимка «до»", () => {
  it("координатный клик: снимок «до» снимается по ТОЙ ЖЕ точке, что уйдёт в наблюдение", async () => {
    await dispatch("p1", { kind: "input.click", target: { by: "coords", x: 640, y: 400, space: "screen" } } as ActionCommand);
    expect(captureUiFingerprint).toHaveBeenCalledWith({ x: 640, y: 400 });
    // Точка наблюдения приходит из фактического результата клика (в моке она своя) — важно, что
    // снимок «до» получил ИМЕННО планируемую точку, иначе сравнивались бы разные области.
    expect((observeAfterAction.mock.calls[0]?.[0] as { clickPoint?: unknown })?.clickPoint).toBeDefined();
  });

  it("цель по тексту/роли: точки заранее нет — снимок «до» зовётся без неё (наблюдение честно останется слабым)", async () => {
    await dispatch("p2", { kind: "input.click", target: { by: "role", role: "Button", name: "Играть" } } as ActionCommand);
    expect(captureUiFingerprint).toHaveBeenCalledWith(undefined);
  });
});

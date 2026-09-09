/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ — политика вуали, чистая таблица (контроль-5, ACT-6). Что охраняет: гейт по виду команды
 * (mode:"up" проходит, фокус окна — нет), пометка сенсоров/наблюдений, чтение кода вуали из скрипта по exit-коду.
 */
import { describe, expect, it } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { OVERLAY_EXIT_CODE, arrangeGatedUnderVeil, focusStealsUnderVeil, isVeilGatedInput, keyGatedUnderVeil, mouseGatedUnderVeil, overlayDrawingFromCodeRun, stepGatedUnderVeil, stepInjectsIntoGui, veilRelevant } from "./veil-policy.js";

const cmd = (c: unknown): ActionCommand => c as ActionCommand;

describe("isVeilGatedInput — что отклоняем во время рисования", () => {
  it.each([
    [{ kind: "input.type", text: "x" }, true],
    [{ kind: "input.mouse", op: "move", x: 1, y: 1 }, true],
    [{ kind: "input.mouse", op: "down", button: "left" }, true],
    // Контроль-8 (mouse-up-gated): отпускание зажатой кнопки проходит — как input.key{mode:"up"} (иначе кнопка
    // остаётся физически зажатой до watchdog сайдкара ровно тогда, когда владелец обводит область мышью).
    // Контроль-9 (mouse-up-terminates-owner-drawing): послабление контроля-8 ОТМЕНЕНО — `mouseup` в окно рисования
    // немедленно завершает выделение владельца в точке курсора (у клавиш `up` такого эффекта нет).
    [{ kind: "input.mouse", op: "up", button: "left" }, true],
    [{ kind: "input.key", combo: "W" }, true],
    [{ kind: "input.key", combo: "W", mode: "down" }, true],
    [{ kind: "input.key", combo: "W", mode: "up" }, false],
    [{ kind: "input.click", target: { by: "coords", x: 1, y: 1 } }, true],
    [{ kind: "input.click", target: { by: "handle", handle: "7" }, method: "physical" }, true],
    [{ kind: "input.click", target: { by: "handle", handle: "7" } }, false],
    [{ kind: "window.focus", query: "Discord" }, true],
    [{ kind: "app.focus", app: "discord" }, true],
    // Контроль-6 (C5R-6): новое окно приложения и SW_MAXIMIZE/SW_RESTORE активируют окно — отбирают клавиатуру у рисования.
    [{ kind: "app.launch", app: "notepad" }, true],
    [{ kind: "window.arrange", op: "maximize", hwnd: 7 }, true],
    [{ kind: "window.arrange", op: "restore", hwnd: 7 }, true],
    [{ kind: "window.arrange", op: "minimize", hwnd: 7 }, false],
    // Контроль-7 (runner-1): move ТОЖЕ активирует (SW_RESTORE свёрнутого/развёрнутого, maximizeAfterMove) — гейтится.
    [{ kind: "window.arrange", op: "move", hwnd: 7, monitor: 1 }, true],
    // Контроль-7 (sensors-3): окно браузера встаёт на передний план — как app.launch (раннер это уже гейтил, dispatch — нет).
    [{ kind: "browser.open", url: "https://youtube.com", inDefault: true }, true],
    [{ kind: "window.list" }, false],
    [{ kind: "ui.invoke", target: { by: "handle", handle: "7" } }, false],
    [{ kind: "screen.capture" }, false],
  ])("%j → %s", (c, gated) => {
    expect(isVeilGatedInput(cmd(c))).toBe(gated);
  });

  it("keyGatedUnderVeil — одно знание для dispatch и точки инжекции", () => {
    expect(keyGatedUnderVeil(undefined)).toBe(true);
    expect(keyGatedUnderVeil("press")).toBe(true);
    expect(keyGatedUnderVeil("down")).toBe(true);
    expect(keyGatedUnderVeil("up")).toBe(false);
  });

  it("mouseGatedUnderVeil — то же для мыши: отпускание кнопки проходит (контроль-8)", () => {
    expect(mouseGatedUnderVeil(undefined)).toBe(true);
    expect(mouseGatedUnderVeil("down")).toBe(true);
    expect(mouseGatedUnderVeil("drag")).toBe(true);
    expect(mouseGatedUnderVeil("up")).toBe(true); // контроль-9: мышь под вуалью гейтится ЦЕЛИКОМ
  });

  it("focusStealsUnderVeil — суффикс «отобрала бы клавиатуру у окна рисования» для всех отборщиков фокуса (контроль-6 C5R-6)", () => {
    for (const k of ["window.focus", "app.focus", "app.launch", "window.arrange", "browser.open"] as const) expect(focusStealsUnderVeil(k)).toBe(true);
    for (const k of ["input.type", "input.click", "screen.capture"] as const) expect(focusStealsUnderVeil(k)).toBe(false);
  });
});

// Контроль-6 (SR-C6-1): раннер зовёт актуаторы МИМО раннего гейта dispatch — та же таблица в терминах SkillStep.
describe("stepGatedUnderVeil — шаг реплея/берста, который под вуалью не идёт в актуатор", () => {
  it.each([
    [{ action: "app.focus", params: { app: "discord" } }, true],
    [{ action: "app.launch", params: { app: "notepad" } }, true],
    [{ action: "browser.open", params: { url: "https://x" } }, true],
    [{ action: "input.type", params: { text: "x" } }, true],
    [{ action: "input.mouse", params: { op: "move", x: 1, y: 1 } }, true],
    [{ action: "input.mouse", params: { op: "up", button: "left" } }, true], // контроль-9: та же таблица, что у dispatch
    [{ action: "input.key", params: { combo: "Enter" } }, true],
    [{ action: "input.key", params: { combo: "W", mode: "up" } }, false],
    [{ action: "input.click", target: { by: "coords", x: 1, y: 1 } }, true],
    [{ action: "input.click", target: { by: "handle", handle: "7" }, params: { method: "physical" } }, true],
    [{ action: "input.click", target: { by: "handle", handle: "7" } }, false],
    [{ action: "ui.invoke", target: { by: "handle", handle: "7" } }, false],
    [{ action: "wait", params: { ms: 100 } }, false],
  ])("%j → %s", (s, gated) => {
    expect(stepGatedUnderVeil(s as never)).toBe(gated);
  });
});

// Контроль-7 (sensors-2): «действие ушло в GUI» — правда только для шагов, которые инжектируют; пауза/грундинг/сверка — нет.
describe("stepInjectsIntoGui — какие шаги реально инжектируют", () => {
  it.each([
    ["input.type", true],
    ["input.key", true],
    ["input.click", true],
    ["input.mouse", true],
    ["ui.invoke", true],
    ["app.launch", true],
    ["app.focus", true],
    ["browser.open", true],
    ["wait", false],
    ["ground", false],
    ["verify", false],
    ["ui.ground", false],
  ])("%s → %s", (action, injects) => {
    expect(stepInjectsIntoGui({ action })).toBe(injects);
  });
});

describe("veilRelevant — что помечать «снято под вуалью»", () => {
  it.each([
    [{ kind: "screen.capture" }, undefined, true],
    // Контроль-7 (sensors-8/-4): EnumWindows и UIA-поиск с фолбэком на весь стол от вуали не слепнут — не помечаем.
    [{ kind: "window.list" }, undefined, false],
    [{ kind: "ui.ground", query: { role: "button", name: "Отправить" } }, { handle: 42 }, false],
    // Контроль-6 (C5R-4): EnumWindows по заголовку/процессу от вуали не слепнет — достоверный исход не выбрасываем.
    [{ kind: "wait.for", condition: { kind: "window", titleContains: "x" } }, undefined, false],
    [{ kind: "wait.for", condition: { kind: "ui", role: "button", name: "OK" } }, undefined, true],
    [{ kind: "wait.for", condition: { kind: "text", text: "x" } }, undefined, true],
    // Контроль-6 (C5R-5): снапшот ЯВНО заданного окна (pid) — его UIA-дерево, не оверлей.
    [{ kind: "ui.snapshot" }, { items: [] }, true],
    [{ kind: "ui.snapshot", pid: 4242 }, { items: [] }, false],
    [{ kind: "wait.for", condition: { kind: "file", path: "C:/x" } }, undefined, false],
    [{ kind: "wait.for", condition: { kind: "process", name: "x" } }, undefined, false],
    [{ kind: "wait.for", condition: { kind: "sound" } }, undefined, false],
    [{ kind: "screen.selection", op: "view" }, undefined, true],
    [{ kind: "screen.selection", op: "clear" }, undefined, false],
    [{ kind: "ui.invoke", target: { by: "handle", handle: "7" } }, { observation: { text: "x" } }, true],
    [{ kind: "ui.invoke", target: { by: "handle", handle: "7" } }, { ok: true }, false],
    [{ kind: "fs.view", path: "x" }, { image: "b64" }, false],
  ])("%j / %j → %s", (c, data, relevant) => {
    expect(veilRelevant(cmd(c), data)).toBe(relevant);
  });
});

describe("overlayDrawingFromCodeRun — структурный сигнал, не текстовый маркер", () => {
  it("exit 77 с маркером → причина из ПОСЛЕДНЕЙ строки с маркером; без done= — done 0 (старый маркер)", () => {
    expect(overlayDrawingFromCodeRun({ exitCode: OVERLAY_EXIT_CODE, stderr: "Traceback…\n[overlay_drawing] done=0 injected=0 input.click: оверлей открыт" })).toEqual({ reason: "input.click: оверлей открыт", done: 0, injected: false });
    expect(overlayDrawingFromCodeRun({ exitCode: OVERLAY_EXIT_CODE, stderr: "jarvis.JarvisError: [overlay_drawing] input.click: оверлей открыт" })).toEqual({ reason: "input.click: оверлей открыт", done: 0, injected: false });
  });
  it("контроль-6 (V5-2): done=N и injected=1 читаются из маркера — сделанное до остановки едет как stepIndex", () => {
    expect(overlayDrawingFromCodeRun({ exitCode: 77, stderr: "печатал…\n[overlay_drawing] done=3 injected=1 input.type: Печать УЖЕ УШЛА" })).toEqual({ reason: "input.type: Печать УЖЕ УШЛА", done: 3, injected: true });
    expect(overlayDrawingFromCodeRun({ exitCode: 77, stderr: "[overlay_drawing] done=2 injected=0" })).toEqual({ reason: "поверх экрана вуаль режима выделения", done: 2, injected: false });
  });
  it("нужны ОБА признака: exit 77 без маркера → null (чужой скрипт мог выйти 77 сам); exit 1 с маркером → null (упал позже на своём)", () => {
    expect(overlayDrawingFromCodeRun({ exitCode: 77, stderr: "" })).toBeNull();
    expect(overlayDrawingFromCodeRun({ exitCode: 77, stderr: "jarvis.JarvisError: [overlay_drawing]" })?.reason).toMatch(/вуаль/u);
    expect(overlayDrawingFromCodeRun({ exitCode: 1, stderr: "[overlay_drawing] x\nKeyError" })).toBeNull();
  });
  it("SDK есть только у python: node/powershell с кодом 77 и «маркером» — не вуаль", () => {
    expect(overlayDrawingFromCodeRun({ exitCode: 77, stderr: "[overlay_drawing] x", lang: "node" })).toBeNull();
    expect(overlayDrawingFromCodeRun({ exitCode: 77, stderr: "[overlay_drawing] x", lang: "python" })?.reason).toBe("x");
  });
  it("таймаут — не вуаль, даже с нашим кодом выхода", () => {
    expect(overlayDrawingFromCodeRun({ exitCode: 77, stderr: "[overlay_drawing] x", timedOut: true })).toBeNull();
  });
});

// Контроль-9 (mouse-up-terminates-owner-drawing): послабление контроля-8 отменено — `mouseup` в окно рисования
// НЕМЕДЛЕННО завершает выделение владельца в точке курсора (у клавиш `up` такого эффекта нет).
describe("мышь под вуалью гейтится ЦЕЛИКОМ", () => {
  it("input.mouse{op:'up'} отвергается, как и остальные операции мыши", () => {
    expect(mouseGatedUnderVeil("up")).toBe(true);
    expect(mouseGatedUnderVeil("down")).toBe(true);
    expect(isVeilGatedInput({ kind: "input.mouse", op: "up" } as never)).toBe(true);
  });

  it("у клавиш послабление ОСТАЁТСЯ: отпускание клавиши побочного эффекта в оверлей не даёт", () => {
    expect(keyGatedUnderVeil("up")).toBe(false);
    expect(keyGatedUnderVeil("press")).toBe(true);
  });

  it("window.arrange: одно знание для раннего гейта и для точки действия", () => {
    expect(arrangeGatedUnderVeil("move")).toBe(true);
    expect(arrangeGatedUnderVeil("minimize")).toBe(false);
  });
});

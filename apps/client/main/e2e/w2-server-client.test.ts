/**
 * Интеграция W2 (план §5.2): СКВОЗНЫЕ сценарии с НАСТОЯЩИМИ судьями по обе стороны провода — серверный dispatchTool
 * (кадр задачи, §0/§14-гейты, вопрос и ОДИН повтор с грантом, act{steps}) → JSON → клиентский dispatch в области
 * серверной команды → рубеж инжекции (self/§0/§14) → фейковый сайдкар в реальной форме (test-support/server-link).
 *
 *  1. capture → act{x,y}: координаты модели в кадре задачи → клиент переводит в ТОЧНЫЙ DIP кнопки (4K @150 %, кадр 1920);
 *  2. G-15: «привет\nкак дела» в Telegram без гранта — НОЛЬ печати (вопрос от клиентского рубежа; «нет» → ничего);
 *     «да» → грант key:enter ×1 → куски и Enter по порядку;
 *  3. act{type,enter:true} и Enter-шаг act{steps} в Telegram → вопрос владельцу; у act{type,enter} — ДО первой буквы
 *     (и когда сервер место знает, и когда его знает только клиент); у серии — на шаге Enter, набранное в вопросе;
 *  4. §0 посреди act (клик в поле ушёл, поле оказалось паролем) — denied без needsApproval, но с stepActionInjected →
 *     сервер: uncertain («исход неизвестен»), не «не сделано».
 * Реверт-проверка: убери ранний Enter в act.ts — (3) падает; preflightText в type-chunks — (2); injectedFailure — (4);
 * noteFrame/frame в dispatch — (1).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Сервер читает каталог данных на загрузке модулей — изолированный tmp, как vitest.setup сервера.
await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  if (!process.env.JARVIS_DATA_DIR?.trim()) process.env.JARVIS_DATA_DIR = mkdtempSync(join(tmpdir(), "jarvis-e2e-data-"));
});

vi.mock("electron", async () => (await import("../test-support/fake-capturer.js")).fakeElectronModule());
vi.mock("../actuators/sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());
vi.mock("../actuators/messaging.js", () => ({ sendMessage: async () => ({ messageId: "1" }), configureSenders: () => undefined }));

import { resetCapturer } from "../test-support/fake-capturer.js";
import { type FakeSidecar, useFakeSidecar } from "../test-support/fake-sidecar.js";
import { NOTEPAD, TELEGRAM, el, front } from "../test-support/rubezh-fixtures.js";
import { linkServerToClient } from "../test-support/server-link.js";
import { selectionStore } from "../selection/store.js";
import { _resetFramesForTest } from "../actuators/frames.js";
import { resetMirror } from "../actuators/handle-mirror.js";
import { resetHeldKeys } from "../actuators/input.js";
import { inputBuffer } from "../actuators/input-buffer.js";
import { resetSecretMemory } from "../actuators/secret-memory.js";
import { resetFieldCache } from "../actuators/focused-field.js";

let side: FakeSidecar;
const ops = (): string[] => side.mutations().map((c) => (c.op === "key" ? `key:${String(c.args.combo)}` : c.op === "type" ? `type:${String(c.args.text)}` : c.op));
const text = (r: { content: unknown }): string => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
const MESSAGE = el(12, "Сообщение", "edit", { x: 20, y: 900, w: 460, h: 32 });

beforeEach(() => {
  process.env.JARVIS_FUSED_OBSERVE = "0"; // наблюдение после действия — не предмет сценариев (иначе лишние захваты)
  _resetFramesForTest("e2e");
  resetCapturer([{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }]);
  side = useFakeSidecar();
  resetMirror();
  resetHeldKeys();
  resetSecretMemory();
  resetFieldCache();
  inputBuffer.reset();
  selectionStore.setDrawing(false);
  side.windows = front(TELEGRAM);
  side.snapshot = { window: TELEGRAM.title, pid: TELEGRAM.pid, items: [el(41, "Отправить"), MESSAGE], truncated: false };
  side.focusedText = "ControlType.Edit: Сообщение";
});

describe("1. кадр задачи: capture → act{x,y} → точный DIP", () => {
  it("4K @150 %, кадр 1920: клик по центру кнопки на картинке → сайдкар жмёт DIP кнопки (2040, 1020)", async () => {
    resetCapturer([{ id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5 }]);
    side.windows = [{ hwnd: 9, pid: 500, process: "dota2", title: "Dota 2", x: 0, y: 0, w: 3840, h: 2160, foreground: true }];
    side.snapshot = { window: "Dota 2", pid: 500, items: [], truncated: false };
    side.at = () => null; // игра UIA-слепа под точкой → физический клик ровно в точку
    const link = linkServerToClient({ answer: true, sidecarOps: ops });
    const cap = await link.tool("screen_capture", { monitor: "0" });
    expect(cap.isError).toBe(false);
    expect(cap.data).toMatchObject({ width: 1920, height: 1080, zoom: false });
    // Кнопка: физика (3000,1500) 120×60 → DIP (2000,1000) 80×40 → кадр ×0,75: центр (1530, 765).
    const r = await link.tool("act", { target: { x: 1530, y: 765 } });
    expect(r.isError, text(r)).toBe(false);
    const act = link.sent.find((c) => c.kind === "gui.act") as { target?: { frame?: string } } | undefined;
    expect(act?.target?.frame).toBe((cap.data as { frameId: string }).frameId); // кадр поставил СЕРВЕР, не модель
    expect(side.calls.find((c) => c.op === "click")?.args).toMatchObject({ x: 2040, y: 1020 });
  });

  it("без снимка координаты не уходят: честный отказ сервера, клиенту ничего", async () => {
    const link = linkServerToClient({ answer: true, sidecarOps: ops });
    const r = await link.tool("act", { target: { x: 10, y: 10 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/координаты без кадра/u);
    expect(link.sent).toEqual([]);
  });
});

describe("2. G-15: перевод строки в Telegram = Enter", () => {
  it("место знает только клиент: «привет\\nкак дела» без гранта → вопрос ДО первой буквы; «нет» → ноль печати", async () => {
    const link = linkServerToClient({ answer: false, sidecarOps: ops });
    const r = await link.tool("input_type", { text: "привет\nкак дела" });
    expect(r.declined).toBe(true);
    expect(link.asked).toHaveLength(1);
    expect(link.asked[0]!.sentBefore).toEqual([]);
    expect(link.asked[0]!.question).toMatch(/telegram/iu);
    expect(ops()).toEqual([]);
  });

  it("«да» → повтор с грантом key:enter ×1: куски и Enter по порядку, один вопрос", async () => {
    const link = linkServerToClient({ answer: true, sidecarOps: ops });
    const r = await link.tool("input_type", { text: "привет\nкак дела" });
    expect(r.isError, text(r)).toBe(false);
    expect(link.asked).toHaveLength(1);
    expect(ops()).toEqual(["type:привет", "key:Enter", "type:как дела"]);
    const retry = link.sent.filter((c) => c.kind === "input.type")[1] as { approval?: { grants: unknown[] } } | undefined;
    expect(retry?.approval?.grants).toEqual([{ signature: "key:enter", process: "telegram", count: 1, hwnd: TELEGRAM.hwnd }]);
  });
});

describe("3. Enter в Telegram через act → вопрос владельцу", () => {
  it.each([
    ["место знает сервер (app)", { app: "Telegram" }, "Telegram «Избранное»"],
    ["место знает только клиент", {}, undefined],
  ] as const)("act{type, enter:true}, %s → вопрос ДО первой буквы; «нет» → ни клика, ни буквы", async (_n, over, place) => {
    const link = linkServerToClient({ answer: false, sidecarOps: ops, place });
    const r = await link.tool("act", { ...over, target: "Сообщение", do: "type", text: "привет", enter: true });
    expect(r.declined, text(r)).toBe(true);
    expect(link.asked).toHaveLength(1);
    expect(link.asked[0]!.sentBefore).toEqual([]);
    expect(ops()).toEqual([]);
  });

  it("act{steps}: [печать «привет», Enter] → печать уходит, на шаге Enter вопрос с набранным; «нет» → Enter не нажат", async () => {
    const link = linkServerToClient({ answer: false, sidecarOps: ops });
    const r = await link.tool("act", { steps: [{ target: "Сообщение", do: "type", text: "привет" }, { do: "key", combo: "Enter" }] });
    expect(link.asked).toHaveLength(1);
    expect(link.asked[0]!.sentBefore).toEqual(["invoke", "type:привет"]);
    expect(link.asked[0]!.question).toMatch(/привет/u);
    expect(ops()).toEqual(["invoke", "type:привет"]);
    expect(r.partialSteps).toBe(1);
    expect(text(r)).toMatch(/выполнено 1 из 2/u);
  });
});

describe("4. §0 посреди act: часть ушла, отказ без вопроса", () => {
  it("клик в «Поле 1» ушёл, а поле оказалось паролем → печать не ушла, сервер: uncertain, вопроса нет", async () => {
    side.windows = front(NOTEPAD);
    side.snapshot = { window: NOTEPAD.title, pid: NOTEPAD.pid, items: [el(61, "Поле 1", "edit", { x: 0, y: 60, w: 300, h: 30 })], truncated: false };
    side.focusedText = "ControlType.Edit: Поле 1 [ЗАЩИЩЕНО]";
    const link = linkServerToClient({ answer: true, sidecarOps: ops });
    const r = await link.tool("act", { target: "Поле 1", do: "type", text: "hunter2" });
    expect(r).toMatchObject({ isError: true, uncertain: true });
    expect(text(r)).toMatch(/§0.*ИСХОД НЕИЗВЕСТЕН/u);
    expect(link.asked).toEqual([]);
    expect(ops()).toEqual(["invoke"]);
  });
});

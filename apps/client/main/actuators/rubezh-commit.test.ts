/**
 * W2 П1: рубеж §14 в точке инжекции — клики, invoke, мышь. НАСТОЯЩИЙ actuators/dispatch в области серверной команды
 * (serverExecutor, как у транспорта), фейковый сайдкар в реальной форме (window.list в z-порядке, ground/ground.at
 * плоско, снапшот с handle числом), настоящие судьи и факты.
 *
 * Реверт-проверка (что сломать → какой кейс падает):
 *  - процесс цели = передний план (process-of: handleOf/pointOf → foreground)        → «Chrome спереди», «под точкой»;
 *  - fail-open на неизвестном процессе (commit-judge: unknownProcessDenial → null)     → «окно без заголовка»;
 *  - подпись по запросу, а не по найденному (commit-target: element → name запроса)  → «Отправить файл»;
 *  - findGrant без процесса/срока (commit-approval: liveGrants без expiresAt)        → «чужой процесс, истёкший»;
 *  - нет устаревания зеркала (handle-mirror.isStale → false)                          → «Записать голосовое → Отправить»;
 *  - mouse down без координат не судится (commit-target: cursor → null)              → «курсор над Отправить».
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult, CommitApproval, NeedsApproval } from "@jarvis/protocol";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { type FakeSidecar, useFakeSidecar } from "../test-support/fake-sidecar.js";
import { electronModule, resetElectronMock } from "../test-support/electron-mock.js";
import { CHROME, NOTEPAD, TELEGRAM, approval, el, front } from "../test-support/rubezh-fixtures.js";
import { selectionStore } from "../selection/store.js";
import { serverExecutor } from "./approval-scope.js";
import { resetMirror } from "./handle-mirror.js";
import { resetHeldKeys } from "./input.js";
import { dispatch } from "./index.js";

let fake: FakeSidecar;
const exec = serverExecutor(dispatch);
const run = (cmd: ActionCommand, a?: CommitApproval): Promise<ActionResult> => exec("srv-1", a ? { ...cmd, approval: a } : cmd);
const needs = (r: ActionResult): NeedsApproval | undefined => (r.data as { needsApproval?: NeedsApproval } | undefined)?.needsApproval;
const sendBtn = { handle: 41, x: 500, y: 900, w: 90, h: 32, name: "Отправить", role: "ControlType.Button" };

beforeEach(() => {
  fake = useFakeSidecar();
  resetElectronMock();
  resetMirror();
  resetHeldKeys();
  selectionStore.setDrawing(false);
  fake.windows = front(TELEGRAM);
  fake.snapshot = { window: TELEGRAM.title, pid: TELEGRAM.pid, items: [el(41, "Отправить"), el(12, "Сообщение", "edit", { x: 20, y: 900, w: 460, h: 32 })], truncated: false };
  fake.focusedText = "ControlType.Edit: Сообщение";
});
afterEach(() => {
  electronModule.screen.getCursorScreenPoint = () => ({ x: 0, y: 0 });
});

describe("процесс цели — реальный, не передний план", () => {
  it("Chrome спереди, ground находит «Отправить» только в scope pid Telegram → denied, needsApproval.process = telegram", async () => {
    fake.windows = front(CHROME, TELEGRAM);
    fake.handlers.ground = (a) => {
      if (a.scope === String(TELEGRAM.pid)) return sendBtn;
      throw new Error(`Элемент не найден: role=${String(a.role)}`);
    };
    const r = await run({ kind: "input.click", target: { by: "role", role: "button", name: "Отправить" } });
    expect(r.error?.code).toBe("denied");
    expect(needs(r)).toMatchObject({ process: "telegram", category: "messenger", signature: "click:отправить", hwnd: TELEGRAM.hwnd });
    expect(fake.calls.filter((c) => c.op === "ground").map((c) => c.args.scope)).toEqual(["active", String(TELEGRAM.pid)]);
    expect(fake.mutations()).toEqual([]);
  });

  it("спереди Блокнот, под точкой (выше по z-order) Telegram, ground.at = «Отправить» → denied (бесшумно и физически)", async () => {
    const tgMini = { ...TELEGRAM, x: 400, y: 800, w: 600, h: 280 };
    fake.windows = [{ ...tgMini, foreground: false }, { ...NOTEPAD, foreground: true }];
    for (const method of ["silent", "physical"] as const) {
      const r = await run({ kind: "input.click", target: { by: "coords", x: 540, y: 910, space: "screen" }, method });
      expect(r.error?.code, method).toBe("denied");
      expect(needs(r), method).toMatchObject({ process: "telegram", signature: "click:отправить" });
    }
    expect(fake.mutations()).toEqual([]);
  });

  it("передний план без заголовка (нет в window.list) + Enter: pid по ui.snapshot → Telegram → вопрос; pid не определён → честный отказ", async () => {
    fake.windows = [{ ...TELEGRAM, foreground: false }];
    const r = await run({ kind: "input.key", combo: "Enter" });
    expect(r.error?.code).toBe("denied");
    expect(needs(r)).toMatchObject({ process: "telegram", signature: "key:enter" });
    fake.handlers["ui.snapshot"] = () => {
      throw new Error("UIA: таймаут");
    };
    const r2 = await run({ kind: "input.key", combo: "Enter" }, approval([{ signature: "key:enter", process: "telegram", count: 1 }]));
    expect(r2.error?.code).toBe("denied");
    expect(r2.error?.message).toMatch(/не смог определить программу/u);
    expect(needs(r2)).toBeUndefined();
    expect(fake.count("key")).toBe(0);
  });

  it("mouse down без x/y — судится элемент под КУРСОРОМ; короткий drag по «Отправить» — как клик", async () => {
    electronModule.screen.getCursorScreenPoint = () => ({ x: 540, y: 910 });
    const down = await run({ kind: "input.mouse", op: "down" });
    expect(down.error?.code).toBe("denied");
    expect(needs(down)?.signature).toBe("click:отправить");
    const drag = await run({ kind: "input.mouse", op: "drag", x: 540, y: 910, toX: 543, toY: 912, space: "screen" });
    expect(drag.error?.code).toBe("denied");
    expect(needs(drag)?.signature).toBe("click:отправить");
    expect(fake.mutations()).toEqual([]);
  });
});

describe("подпись — по найденному элементу; грант — ровно на это действие", () => {
  it("грант click:отправить, а act нашёл «Отправить файл» → needsApproval «click:отправить файл», ничего не нажато", async () => {
    fake.snapshot.items = [el(41, "Отправить файл")];
    const r = await run({ kind: "gui.act", app: "Telegram", target: "Отправить" }, approval([{ signature: "click:отправить", process: "telegram", count: 1 }]));
    expect(r.error?.code).toBe("denied");
    expect(needs(r)?.signature).toBe("click:отправить файл");
    expect(fake.mutations()).toEqual([]);
  });

  it("грант чужого процесса или с истёкшим сроком не действует; свой и живой — нажимает ровно раз", async () => {
    const enter: ActionCommand = { kind: "input.key", combo: "Enter" };
    expect((await run(enter, approval([{ signature: "key:enter", process: "discord", count: 1 }]))).error?.code).toBe("denied");
    expect((await run(enter, approval([{ signature: "key:enter", process: "telegram", count: 1 }], -1))).error?.code).toBe("denied");
    expect((await run(enter, approval([{ signature: "key:enter", process: "telegram", count: 1, hwnd: 777 }]))).error?.code).toBe("denied");
    expect(fake.count("key")).toBe(0);
    expect((await run(enter, approval([{ signature: "key:enter", process: "telegram", count: 1, hwnd: TELEGRAM.hwnd }]))).ok).toBe(true);
    expect(fake.count("key")).toBe(1);
  });

  it("№4: снапшот-1 «Записать голосовое» (грант на неё) → печать → на том же месте «Отправить» → invoke 41: вопрос «click:отправить»", async () => {
    fake.snapshot.items = [el(41, "Записать голосовое")];
    expect((await run({ kind: "ui.snapshot" })).ok).toBe(true);
    expect((await run({ kind: "input.type", text: "привет" })).ok).toBe(true);
    fake.snapshot.items = [el(57, "Отправить")]; // тот же bbox: кнопка сменилась после печати
    const r = await run({ kind: "ui.invoke", target: { by: "handle", handle: "41" }, pattern: "invoke" }, approval([{ signature: "click:записать голосовое", process: "telegram", count: 1 }]));
    expect(r.error?.code).toBe("denied");
    expect(needs(r)?.signature).toBe("click:отправить");
    expect(fake.count("invoke")).toBe(0);
  });

  it("устаревшая запись, а на месте элемента пусто → отказ «сними ui_snapshot заново» (fail-closed)", async () => {
    await run({ kind: "ui.snapshot" });
    await run({ kind: "input.type", text: "x" });
    fake.snapshot.items = [];
    const r = await run({ kind: "ui.invoke", target: { by: "handle", handle: "41" }, pattern: "invoke" }, approval([{ signature: "click:отправить", process: "telegram", count: 1 }]));
    expect(r.error?.code).toBe("denied");
    expect(r.error?.message).toMatch(/сними ui_snapshot заново/u);
    expect(fake.count("invoke")).toBe(0);
  });
});

describe("№11: физический клик по handle в рискованной программе — в точку, которую судим", () => {
  it("Telegram: handle 12 «Сообщение» (поле), а поверх его центра — «Отправить» → click{x,y} в центр не уходит: вопрос «click:отправить»", async () => {
    await run({ kind: "ui.snapshot" });
    fake.at = () => ({ handle: 41, role: "Button", name: "Отправить", x: 200, y: 890, w: 90, h: 40 }); // всплывашка поверх поля
    const r = await run({ kind: "input.click", target: { by: "handle", handle: "12" }, method: "physical" });
    expect(r.error?.code).toBe("denied");
    expect(needs(r)?.signature).toBe("click:отправить");
    expect(fake.mutations()).toEqual([]);
  });

  it("в обычной программе — клик по handle как прежде (сайдкар сам берёт точку элемента)", async () => {
    fake.windows = front(NOTEPAD);
    fake.snapshot = { window: NOTEPAD.title, pid: NOTEPAD.pid, items: [el(12, "Сохранить")], truncated: false };
    await run({ kind: "ui.snapshot" });
    expect((await run({ kind: "input.click", target: { by: "handle", handle: "12" }, method: "physical" })).ok).toBe(true);
    expect(fake.mutations().map((c) => c.args.handle)).toEqual(["12"]);
  });
});

describe("G-10: точка — invoke только малого элемента", () => {
  it("ListItem 400×64 под точкой → физический click{x,y} ровно в точку (не invoke строки); в отчёте — «ListItem «Катя»»", async () => {
    fake.at = () => ({ handle: 60, role: "ListItem", name: "Катя", x: 0, y: 300, w: 400, h: 64 });
    const r = await run({ kind: "input.click", target: { by: "coords", x: 380, y: 330, space: "screen" } });
    expect(r.ok).toBe(true);
    expect(fake.count("invoke")).toBe(0);
    expect(fake.mutations()).toEqual([{ op: "click", args: { x: 380, y: 330, restoreCursor: true, button: "left", count: 1 } }]);
    expect(r.data).toMatchObject({ pressed: "ListItem «Катя»" });
  });

  it("малая кнопка под точкой в обычной программе → бесшумный invoke по handle", async () => {
    fake.windows = front(NOTEPAD);
    fake.at = () => ({ handle: 61, role: "button", name: "Сохранить", x: 100, y: 100, w: 80, h: 30 });
    const r = await run({ kind: "input.click", target: { by: "coords", x: 120, y: 110, space: "screen" } });
    expect(r.ok).toBe(true);
    expect(fake.mutations().map((c) => [c.op, c.args.handle])).toEqual([["invoke", "61"]]);
  });
});

describe("браузер через GUI — категория web", () => {
  it("Chrome, act «Отправить» без гранта → needsApproval category web; «Настройки» — без вопроса", async () => {
    fake.windows = front(CHROME);
    fake.snapshot = { window: CHROME.title, pid: CHROME.pid, items: [el(41, "Отправить"), el(42, "Настройки", "button", { x: 10, y: 10 })], truncated: false };
    const r = await run({ kind: "gui.act", target: "Отправить" });
    expect(r.error?.code).toBe("denied");
    expect(needs(r)).toMatchObject({ category: "web", process: "chrome", signature: "click:отправить" });
    expect(fake.mutations()).toEqual([]);
    expect((await run({ kind: "gui.act", target: "Настройки" })).ok).toBe(true);
    expect(fake.count("invoke")).toBe(1);
  });
});

/**
 * Интеграция W2 (П4 × П1): act через НАСТОЯЩИЙ dispatch в области серверной команды, настоящие судьи рубежа и факты
 * на фейковом сайдкаре в реальной форме. Стыки, которые пакеты по отдельности не видели:
 *  - invoke отклонён рубежом → физического фолбэка НЕТ (раньше doClick проваливался в физический клик, и тот судился
 *    вторично по элементу под центром — «Отправить» уходило, если UIA под точкой отдавала поле ввода);
 *  - G-10 в act: цель-точка над строкой списка 400×64 — физический клик ровно в точку, не invoke строки; малая
 *    кнопка под точкой — invoke;
 *  - печать без цели, отклонённая ДО первой буквы, — «ничего не ушло» (не stepActionInjected); после клика в поле —
 *    «часть ушла».
 * Реверт-проверка: убери проброс denied в doClick — падает «Отправить»; верни invoke для любой точки — «строка
 * списка»; отдай first=false печати без цели — «карта в Блокнот».
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult, NeedsApproval } from "@jarvis/protocol";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { type FakeSidecar, useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { NOTEPAD, TELEGRAM, el, front } from "../test-support/rubezh-fixtures.js";
import { selectionStore } from "../selection/store.js";
import { serverExecutor } from "./approval-scope.js";
import { resetMirror } from "./handle-mirror.js";
import { resetHeldKeys } from "./input.js";
import { resetSecretMemory } from "./secret-memory.js";
import { resetFieldCache } from "./focused-field.js";
import { dispatch } from "./index.js";

let fake: FakeSidecar;
const exec = serverExecutor(dispatch);
const act = (over: Partial<Extract<ActionCommand, { kind: "gui.act" }>>): Promise<ActionResult> =>
  exec("srv-1", { kind: "gui.act", observe: false, origin: "user", ...over } as ActionCommand);
const needs = (r: ActionResult): NeedsApproval | undefined => (r.data as { needsApproval?: NeedsApproval } | undefined)?.needsApproval;
const muts = () => fake.mutations().map((c) => ({ op: c.op, ...c.args }));

const MESSAGE = el(12, "Сообщение", "edit", { x: 20, y: 900, w: 460, h: 32 });

beforeEach(() => {
  fake = useFakeSidecar();
  resetElectronMock();
  resetMirror();
  resetHeldKeys();
  resetSecretMemory();
  resetFieldCache();
  selectionStore.setDrawing(false);
  fake.windows = front(TELEGRAM);
  fake.snapshot = { window: TELEGRAM.title, pid: TELEGRAM.pid, items: [el(41, "Отправить"), MESSAGE], truncated: false };
  fake.focusedText = "ControlType.Edit: Сообщение";
});

describe("отказ рубежа на invoke — вердикт, а не «invoke не поддержан»", () => {
  it("«Отправить» в Telegram без гранта: invoke denied → физического клика нет, хотя под центром UIA отдаёт поле ввода", async () => {
    fake.at = () => MESSAGE; // ground.at под центром кнопки видит поле: второй суд физического клика пропустил бы его
    const r = await act({ target: "Отправить" });
    expect(r.error?.code).toBe("denied");
    expect(needs(r)).toMatchObject({ signature: "click:отправить", process: "telegram", category: "messenger" });
    expect(r.stepActionInjected).toBeUndefined();
    expect(fake.mutations()).toEqual([]);
  });
});

describe("G-10 в act: точка — invoke только малого элемента", () => {
  it("строка списка «Катя» 400×64 под точкой → физический клик РОВНО в точку, не invoke строки", async () => {
    const row = el(42, "Катя", "listitem", { x: 300, y: 300, w: 400, h: 64 });
    fake.snapshot.items.push(row);
    fake.at = () => row;
    const r = await act({ target: { x: 650, y: 320, space: "screen" } });
    expect(r.ok).toBe(true);
    expect(muts()).toMatchObject([{ op: "click", x: 650, y: 320, button: "left", count: 1 }]);
  });

  it("малая кнопка под точкой (Блокнот) → бесшумный invoke по её handle", async () => {
    fake.windows = front(NOTEPAD);
    const bold = el(51, "Полужирный", "button", { x: 600, y: 40, w: 24, h: 24 });
    fake.snapshot = { window: NOTEPAD.title, pid: NOTEPAD.pid, items: [bold], truncated: false };
    fake.at = () => bold;
    const r = await act({ target: { x: 610, y: 50, space: "screen" } });
    expect(r.ok).toBe(true);
    expect(muts()).toMatchObject([{ op: "invoke", handle: "51", pattern: "invoke" }]);
  });
});

describe("печать: «ничего не ушло» ≠ «часть ушла»", () => {
  beforeEach(() => {
    fake.windows = front(NOTEPAD);
    fake.snapshot = { window: NOTEPAD.title, pid: NOTEPAD.pid, items: [el(61, "Текст", "edit", { x: 0, y: 60, w: 800, h: 500 })], truncated: false };
    fake.focusedText = "ControlType.Edit: Текст";
  });

  it("карта печатью без цели → §0 до первой буквы: denied, stepActionInjected нет, в сайдкар ничего", async () => {
    const r = await act({ do: "type", text: "4276 1600 1234 5675" });
    expect(r.error?.code).toBe("denied");
    expect(r.data).toEqual({ secretGuard: "card" });
    expect(r.stepActionInjected).toBeUndefined();
    expect(fake.mutations()).toEqual([]);
  });

  it("карта в поле по цели → клик в поле ушёл, печать — §0: denied + stepActionInjected (клик уже был)", async () => {
    const r = await act({ target: "Текст", do: "type", text: "4276 1600 1234 5675" });
    expect(r.error?.code).toBe("denied");
    expect(r.stepActionInjected).toBe(true);
    expect(fake.mutations().map((c) => c.op)).toEqual(["invoke"]);
  });
});

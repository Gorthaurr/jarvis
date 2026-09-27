/**
 * W2 П1: рубеж §14 и своё окно — КЛАВИАТУРА и печать (G-15). НАСТОЯЩИЙ actuators/dispatch в области серверной команды,
 * фейковый сайдкар в реальной форме (read.screen: первая строка — элемент в фокусе), настоящие судьи.
 *
 * Реверт-проверка:
 *  - денилист вместо allowlist (keyClass: всё, кроме Enter, → safe)             → «Space на кнопке, Alt+S в Outlook»;
 *  - Enter без учёта фокуса (commit-judge: focused не читается)                  → «грант key:enter, в фокусе «Удалить чат»»;
 *  - суд только на Enter-инжекции без preflight всего текста (type-chunks)        → «a\nb в Telegram — ноль печати»;
 *  - после Tab кусок не судится заново (type-chunks: preflightKeys Space убран)    → «hi\t »;
 *  - своё окно в фокусе не судится (self-judge: ownFocused)                       → «своё окно»;
 *  - грант не списывается (commit-judge: g.count -= n убран)                      → «одно да — одна отправка».
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult, CommitApproval, NeedsApproval } from "@jarvis/protocol";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { type FakeSidecar, useFakeSidecar } from "../test-support/fake-sidecar.js";
import { electronState, resetElectronMock } from "../test-support/electron-mock.js";
import { NOTEPAD, OUTLOOK, TELEGRAM, approval, front } from "../test-support/rubezh-fixtures.js";
import { selectionStore } from "../selection/store.js";
import { serverExecutor } from "./approval-scope.js";
import { resetMirror } from "./handle-mirror.js";
import { click, pressKey, resetHeldKeys } from "./input.js";
import { dispatch } from "./index.js";

let fake: FakeSidecar;
const exec = serverExecutor(dispatch);
const run = (cmd: ActionCommand, a?: CommitApproval): Promise<ActionResult> => exec("srv-1", a ? { ...cmd, approval: a } : cmd);
const needs = (r: ActionResult): NeedsApproval | undefined => (r.data as { needsApproval?: NeedsApproval } | undefined)?.needsApproval;
const typed = (): Array<[string, unknown]> => fake.mutations().map((c) => [c.op, c.op === "type" ? c.args.text : c.args.combo]);
const enterGrant = (count: number) => approval([{ signature: "key:enter", process: "telegram", count }]);

beforeEach(() => {
  fake = useFakeSidecar();
  resetElectronMock();
  resetMirror();
  resetHeldKeys();
  selectionStore.setDrawing(false);
  fake.windows = front(TELEGRAM);
  fake.focusedText = "ControlType.Edit: Сообщение";
});

describe("клавиши — allowlist и элемент в фокусе", () => {
  it("Telegram: Space на КНОПКЕ «Отправить» в фокусе → вопрос «click:отправить»; Space в поле — пробел, без вопроса", async () => {
    fake.focusedText = "ControlType.Button: Отправить";
    const r = await run({ kind: "input.key", combo: "Space" });
    expect(r.error?.code).toBe("denied");
    expect(needs(r)).toMatchObject({ signature: "click:отправить", process: "telegram", windowTitle: "Избранное — Telegram" });
    fake.focusedText = "ControlType.Edit: Сообщение";
    expect((await run({ kind: "input.key", combo: "Space" })).ok).toBe(true);
    expect(typed()).toEqual([["key", "Space"]]);
  });

  it("Outlook: Alt+S (отправить письмо) — коммит по allowlist; Ctrl+Enter — тоже; Enter в теле письма — абзац", async () => {
    fake.windows = front(OUTLOOK);
    for (const combo of ["Alt+S", "Ctrl+Enter"]) {
      const r = await run({ kind: "input.key", combo });
      expect(r.error?.code, combo).toBe("denied");
      expect(needs(r)?.category, combo).toBe("messenger");
    }
    fake.focusedText = "ControlType.Document: Текст письма";
    expect((await run({ kind: "input.key", combo: "Enter" })).ok).toBe(true);
    expect((await run({ kind: "input.type", text: "Добрый день,\nспасибо" })).ok).toBe(true);
    expect(typed()).toEqual([["key", "Enter"], ["type", "Добрый день,"], ["key", "Enter"], ["type", "спасибо"]]);
  });

  it("грант key:enter, а в фокусе кнопка «Удалить чат» → Enter = клик по ней: вопрос «click:удалить чат», грант не тратится", async () => {
    fake.focusedText = "ControlType.Button: Удалить чат";
    const a = enterGrant(1);
    const r = await run({ kind: "input.key", combo: "Enter" }, a);
    expect(r.error?.code).toBe("denied");
    expect(needs(r)?.signature).toBe("click:удалить чат");
    expect(fake.count("key")).toBe(0);
  });

  it("одно «да» — одна отправка: грант key:enter ×1 → первый Enter уходит, второй в той же команде — вопрос", async () => {
    const r = await exec("srv-2", {
      kind: "skill.execute",
      skillId: "s",
      version: 1,
      steps: [{ action: "input.key", params: { combo: "Enter" } }, { action: "input.key", params: { combo: "Enter" } }],
      approval: enterGrant(1),
    });
    expect(r.error?.code).toBe("denied");
    expect(r.stepIndex).toBe(1);
    expect(fake.count("key")).toBe(1);
  });

  it("удалённый доступ (mstsc): Enter — вопрос (внутрь сессии UIA не видит); клик по точке — не судится", async () => {
    fake.windows = front({ ...NOTEPAD, process: "mstsc", title: "srv — Подключение к удалённому рабочему столу" });
    const r = await run({ kind: "input.key", combo: "Enter" });
    expect(needs(r)).toMatchObject({ category: "remote", signature: "key:enter", process: "mstsc" });
    expect((await run({ kind: "input.click", target: { by: "coords", x: 50, y: 50, space: "screen" }, method: "physical" })).ok).toBe(true);
  });
});

describe("G-15: печать кусками — весь текст судится ДО первого куска", () => {
  it("«a\\nb» в Блокноте: type a → key Enter → type b", async () => {
    fake.windows = front(NOTEPAD);
    expect((await run({ kind: "input.type", text: "a\nb" })).ok).toBe(true);
    expect(typed()).toEqual([["type", "a"], ["key", "Enter"], ["type", "b"]]);
  });

  it("«привет\\nкак дела\\n» в Telegram без гранта → НОЛЬ напечатанного; вопрос key:enter ×2 с текстом, что уйдёт", async () => {
    const r = await run({ kind: "input.type", text: "привет\nкак дела\n" });
    expect(r.error?.code).toBe("denied");
    expect(r.stepActionInjected).toBeUndefined();
    expect(needs(r)).toMatchObject({ signature: "key:enter", what: "клавиша «enter» ×2" });
    expect(needs(r)?.pendingText).toMatch(/привет.*как дела/u);
    expect(fake.mutations()).toEqual([]);
  });

  it("грант key:enter ×1 на текст с двумя переводами строки — мало: вопрос до первой буквы; ×2 — печать целиком, грант израсходован", async () => {
    expect((await run({ kind: "input.type", text: "a\nb\n" }, enterGrant(1))).error?.code).toBe("denied");
    expect(fake.mutations()).toEqual([]);
    const a = enterGrant(2);
    expect((await run({ kind: "input.type", text: "a\nb\n" }, a)).ok).toBe(true);
    expect(typed()).toEqual([["type", "a"], ["key", "Enter"], ["type", "b"], ["key", "Enter"]]);
    expect(a.grants[0]!.count).toBe(2); // конверт команды не тронут: списание — в копии области
  });

  it("«hi\\t » в Telegram: после Tab фокус на кнопке «Отправить» — пробел не печатается (часть ушла → stepActionInjected)", async () => {
    fake.handlers.key = (args) => {
      if (args.combo === "Tab") fake.focusedText = "ControlType.Button: Отправить";
      return { success: true };
    };
    const r = await run({ kind: "input.type", text: "hi\t " });
    expect(r.error?.code).toBe("denied");
    expect(r.stepActionInjected).toBe(true);
    expect(typed()).toEqual([["type", "hi"], ["key", "Tab"]]);
  });
});

describe("своё окно (self) — неодобряемо", () => {
  it("фокус у окна Джарвиса → key и type не уходят даже с грантом", async () => {
    electronState.ownFocused = true;
    const a = approval([{ signature: "key:enter", process: "telegram", count: 5 }]);
    const k = await run({ kind: "input.key", combo: "Enter" }, a);
    const t = await run({ kind: "input.type", text: "привет" }, a);
    for (const r of [k, t]) {
      expect(r.error?.code).toBe("denied");
      expect(r.error?.message).toMatch(/окно самого Джарвиса/u);
    }
    expect(fake.mutations()).toEqual([]);
  });
});

describe("цена рубежа — число фактов", () => {
  it("key W down — ни одного window.list; клик по точке в обычном окне — ≤ 1 window.list и 0 ground.at", async () => {
    await pressKey("W", "down");
    expect(fake.count("window.list")).toBe(0);
    await pressKey("W", "up");
    fake.windows = front(NOTEPAD);
    await click({ by: "coords", x: 100, y: 100, space: "screen" }, "physical");
    expect(fake.count("window.list")).toBeLessThanOrEqual(1);
    expect(fake.count("ground.at")).toBe(0);
    expect(fake.count("click")).toBe(1);
  });
});

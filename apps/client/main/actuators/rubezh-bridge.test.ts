/**
 * W2 П1: SDK-мост через НАСТОЯЩИЙ loopback-мост и НАСТОЯЩИЙ actuators/dispatch (фейковый сайдкар в реальной форме).
 * Мост — вход для python под prompt-injection: одобрения у него нет никогда, своё окно — неодобряемо, запуск/закрытие —
 * по allowlist. Рубеж судит каждую инжекцию, а не точку входа.
 *
 * Реверт-проверка:
 *  - вызов рубежа убран из inject.ts (sidecar().request напрямую)                  → «invoke 41 в Telegram»;
 *  - проверка своего pid снята (self-judge → null)                                 → «своё окно даже с грантом»;
 *  - одобрение из тела моста / enterWith (bridge-exec: runWithoutApproval убран)    → «approval в теле, параллельно»;
 *  - зеркало без поколения (mirrorOf игнорирует gen)                              → «рестарт сайдкара»;
 *  - bridge-uri/closeDenial → null                                                → «app.close force, skype:».
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { type FakeSidecar, useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { CHROME, OWN, TELEGRAM, approval, el, front } from "../test-support/rubezh-fixtures.js";
import { selectionStore } from "../selection/store.js";
import { type ActBridge, startActBridge } from "./act-bridge.js";
import { serverExecutor } from "./approval-scope.js";
import { resetMirror } from "./handle-mirror.js";
import { resetHeldKeys } from "./input.js";
import { dispatch } from "./index.js";

let fake: FakeSidecar;
let bridge: ActBridge | null = null;
const post = async (body: Record<string, unknown>): Promise<ActionResult> =>
  (await (await fetch(`http://127.0.0.1:${bridge!.port}/act`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-token": bridge!.token }, body: JSON.stringify(body) })).json()) as ActionResult;
const invoke41 = { kind: "ui.invoke", target: { by: "handle", handle: "41" }, pattern: "invoke" };

beforeEach(async () => {
  fake = useFakeSidecar();
  resetElectronMock();
  resetMirror();
  resetHeldKeys();
  selectionStore.setDrawing(false);
  fake.windows = front(TELEGRAM);
  fake.snapshot = { window: TELEGRAM.title, pid: TELEGRAM.pid, items: [el(41, "Отправить")], truncated: false };
  bridge = await startActBridge(dispatch);
});
afterEach(async () => {
  await bridge?.stop();
  bridge = null;
});

describe("мост — коммит без одобрения невозможен", () => {
  it("ui.snapshot Telegram (41 «Отправить») → ui.invoke{handle:\"41\"} → denied, invoke в сайдкар не ушёл", async () => {
    expect((await post({ kind: "ui.snapshot" })).ok).toBe(true);
    const r = await post(invoke41);
    expect(r.error?.code).toBe("denied");
    expect(r.error?.message).toMatch(/SDK-мост его не делает/u);
    expect(fake.count("invoke")).toBe(0);
  });

  it("approval/commitApproved в теле моста, ПАРАЛЛЕЛЬНО одобренной серверной команде → denied; сама команда свой грант использует", async () => {
    await post({ kind: "ui.snapshot" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const grant = approval([{ signature: "click:отправить", process: "telegram", count: 1 }]);
    const server = serverExecutor(async (id, cmd) => {
      await gate; // команда сервера «висит» (code_run): python в это время дёргает мост
      return dispatch(id, cmd);
    })("srv-1", { ...(invoke41 as ActionCommand), approval: grant });
    const r = await post({ ...invoke41, approval: grant, commitApproved: true });
    expect(r.error?.code).toBe("denied");
    expect(fake.count("invoke")).toBe(0);
    release();
    expect((await server).ok).toBe(true);
    expect(fake.count("invoke")).toBe(1);
  });

  it("Chrome: act «Отправить» через мост → отказ с подсказкой browser_act", async () => {
    fake.windows = front(CHROME);
    fake.snapshot = { window: CHROME.title, pid: CHROME.pid, items: [el(41, "Отправить")], truncated: false };
    const r = await post({ kind: "gui.act", target: "Отправить" });
    expect(r.error?.code).toBe("denied");
    expect(r.error?.message).toMatch(/browser_act/u);
    expect(fake.mutations()).toEqual([]);
  });

  it("рестарт сайдкара внутри одобренной команды → мостовой invoke по старому handle: denied, старое зеркало не используется", async () => {
    const grant = approval([{ signature: "click:отправить", process: "telegram", count: 5 }]);
    const r = await serverExecutor(async (id) => {
      await post({ kind: "ui.snapshot" }); // handle 41 выдан поколением 1
      fake.generation += 1; // сайдкар упал и поднялся: handle 41 теперь чужой
      return post(invoke41).then((b) => ({ ...b, commandId: id }));
    })("srv-1", { kind: "code.run", lang: "python", code: "", approval: grant });
    expect(r.error?.code).toBe("denied");
    expect(r.error?.message).toMatch(/handle 41 неизвестен/u);
    expect(fake.count("invoke")).toBe(0);
  });
});

describe("своё окно — отказ даже с грантом в области", () => {
  const ownGrant = approval([{ signature: "click:подтвердить", process: "jarvis", count: 5 }]);
  const asServer = (cmd: ActionCommand): Promise<ActionResult> => serverExecutor(dispatch)("srv-1", { ...cmd, approval: ownGrant });

  it("мост: ui.snapshot{pid: process.pid} → invoke «Подтвердить» — denied (своё окно)", async () => {
    fake.snapshot = { window: "Джарвис", pid: process.pid, items: [el(77, "Подтвердить")], truncated: false };
    await post({ kind: "ui.snapshot", pid: process.pid });
    const r = await post({ kind: "ui.invoke", target: { by: "handle", handle: "77" }, pattern: "invoke" });
    expect(r.error?.message).toMatch(/окно самого Джарвиса/u);
    expect(fake.count("invoke")).toBe(0);
  });

  it("сервер с грантом: input.click по роли → элемент своего окна; точка в своём окне (верхнее по z-order) — denied", async () => {
    fake.windows = [{ ...OWN, foreground: true }, { ...TELEGRAM, foreground: false }];
    fake.snapshot = { window: "Джарвис", pid: process.pid, items: [el(77, "Подтвердить", "button", { x: 100, y: 200 })], truncated: false };
    const byRole = await asServer({ kind: "input.click", target: { by: "role", role: "button", name: "Подтвердить" } });
    const byPoint = await asServer({ kind: "input.click", target: { by: "coords", x: 120, y: 210, space: "screen" }, method: "physical" });
    for (const r of [byRole, byPoint]) {
      expect(r.error?.code).toBe("denied");
      expect(r.error?.message).toMatch(/окно самого Джарвиса/u);
    }
    expect(fake.mutations()).toEqual([]);
  });
});

describe("мост — запуск и закрытие по allowlist (N-4, №17)", () => {
  it("app.close{force} и app.launch «skype:?call» / «tg://…» → denied, до актуатора и сайдкара не доходит", async () => {
    for (const body of [{ kind: "app.close", app: "Telegram", force: true }, { kind: "app.launch", app: "skype:?call" }, { kind: "app.launch", app: "tg://resolve?domain=x" }]) {
      const r = await post(body);
      expect(r.error?.code, JSON.stringify(body)).toBe("denied");
    }
    expect(fake.calls).toEqual([]);
  });
});

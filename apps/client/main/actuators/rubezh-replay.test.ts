/**
 * W2 П1 (безопасность №5): реплей навыка (skill.execute / input_batch) через НАСТОЯЩИЙ actuators/dispatch → раннер →
 * createClientActuator → рубеж инжекции (фейковый сайдкар в реальной форме). Гранты — только из области серверной
 * команды; у локального реплея из UI области с одобрением нет (решение владельца §8 №1: честный отказ).
 *
 * Реверт-проверка:
 *  - раннер ретраит отказ рубежа (step-policy.injectionDenial → null)               → «invoke 0 раз, stepIndex 1» (3 попытки);
 *  - коммит-шаг получает ретраи (stepRetries → кап 5 для всех)                        → «проваленный expect: invoke ровно 1»;
 *  - грант не списывается (commit-judge)                                            → «грант ×1, два «Отправить»»;
 *  - локальная область = серверная (commit-approval: via не проверяется)             → «локальный реплей».
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, NeedsApproval, SkillStep } from "@jarvis/protocol";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { type FakeSidecar, useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { TELEGRAM, approval, el, front } from "../test-support/rubezh-fixtures.js";
import { selectionStore } from "../selection/store.js";
import { runWithoutApproval, serverExecutor } from "./approval-scope.js";
import { resetMirror } from "./handle-mirror.js";
import { resetHeldKeys } from "./input.js";
import { dispatch } from "./index.js";

let fake: FakeSidecar;
const exec = serverExecutor(dispatch);
const skill = (steps: SkillStep[]): ActionCommand => ({ kind: "skill.execute", skillId: "s", version: 1, steps });
const send: SkillStep = { action: "ui.invoke", target: { by: "role", role: "button", name: "Отправить" } };

beforeEach(() => {
  fake = useFakeSidecar();
  resetElectronMock();
  resetMirror();
  resetHeldKeys();
  selectionStore.setDrawing(false);
  fake.windows = front(TELEGRAM);
  fake.snapshot = { window: TELEGRAM.title, pid: TELEGRAM.pid, items: [el(41, "Отправить")], truncated: false };
  fake.focusedText = "ControlType.Edit: Сообщение";
});

describe("реплей: отказ рубежа — стоп без ретраев, вопрос с номером шага", () => {
  it("[type «привет», invoke «Отправить»] без гранта → стоп на шаге 2: invoke 0 раз, stepIndex 1, denied + needsApproval", async () => {
    const r = await exec("srv-1", skill([{ action: "input.type", params: { text: "привет" } }, send]));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("denied");
    expect(r.stepIndex).toBe(1);
    expect((r.data as { needsApproval?: NeedsApproval }).needsApproval).toMatchObject({ signature: "click:отправить", process: "telegram" });
    expect(fake.count("type")).toBe(1);
    expect(fake.count("invoke")).toBe(0);
    expect(fake.count("click")).toBe(0);
  });

  it("коммит-шаг с грантом и проваленным expect → invoke РОВНО 1 раз (ретрай ушедшего = вторая отправка), исход «ушло»", async () => {
    const step: SkillStep = { ...send, expect: { role: "text", name: "Отправлено" }, timeoutMs: 50, retries: 2 };
    const r = await exec("srv-1", { ...skill([step]), approval: approval([{ signature: "click:отправить", process: "telegram", count: 5 }]) });
    expect(r.ok).toBe(false);
    expect(fake.count("invoke")).toBe(1);
    expect(r.stepActionInjected).toBe(true);
  });

  it("грант ×1, в реплее два «Отправить» → первое уходит, второе — denied (stepIndex 1)", async () => {
    const r = await exec("srv-1", { ...skill([send, send]), approval: approval([{ signature: "click:отправить", process: "telegram", count: 1 }]) });
    expect(r.error?.code).toBe("denied");
    expect(r.stepIndex).toBe(1);
    expect(fake.count("invoke")).toBe(1);
  });

  it("локальный реплей из UI (область local, без одобрения) с Enter в Telegram → denied, клавиша не ушла", async () => {
    const r = await runWithoutApproval("local", () => dispatch("local-1", skill([{ action: "input.key", params: { combo: "Enter" } }])));
    expect(r.error?.code).toBe("denied");
    expect(r.error?.message).toMatch(/локальный реплей/u);
    expect(fake.count("key")).toBe(0);
  });

  it("шаг app.launch «zoommtg:…» — отказ до запуска, без ретраев", async () => {
    const r = await exec("srv-1", skill([{ action: "app.launch", params: { app: "zoommtg://zoom.us/join?confno=1" }, retries: 3 }]));
    expect(r.error?.code).toBe("denied");
    expect(r.error?.message).toMatch(/схема «zoommtg:»/u);
  });
});

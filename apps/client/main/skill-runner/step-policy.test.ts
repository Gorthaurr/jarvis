/**
 * W2 П1 (№5): политика повторов реплея — шаг «коммит или неизвестно» не ретраится, отказ рубежа — стоп с данными.
 * Сквозной путь (dispatch → раннер → рубеж) — actuators/rubezh-replay.test.ts; здесь — таблица классов шагов и
 * проводка отказа в раннере на мок-актуаторе. Реверт: stepMayCommit → false — «Enter/«Отправить»/координаты» падают;
 * injectionDenial → null — отказ ретраится (executeStep ×3).
 */
import { describe, expect, it, vi } from "vitest";
import type { SkillStep } from "@jarvis/protocol";
import { ActionError } from "../actuators/action-error.js";
import { outcomeToActionResult, runSkill } from "./index.js";
import { stepMayCommit, stepRetries } from "./step-policy.js";

const s = (action: string, extra: Partial<SkillStep> = {}): SkillStep => ({ action, ...extra });

describe("stepMayCommit — строжайший allowlist (мессенджер)", () => {
  it.each<[string, SkillStep, boolean]>([
    ["печать без перевода строки", s("input.type", { params: { text: "привет" } }), false],
    ["печать с \\n", s("input.type", { params: { text: "привет\n" } }), true],
    ["Tab / стрелка", s("input.key", { params: { combo: "Tab" } }), false],
    ["Enter", s("input.key", { params: { combo: "Enter" } }), true],
    ["Ctrl+S (вне allowlist)", s("input.key", { params: { combo: "Ctrl+S" } }), true],
    ["отпустить клавишу", s("input.key", { params: { combo: "Enter", mode: "up" } }), false],
    ["клик по полю «Сообщение»", s("input.click", { target: { by: "role", role: "edit", name: "Сообщение" } }), false],
    ["клик по «Отправить»", s("input.click", { target: { by: "role", role: "button", name: "Отправить" } }), true],
    ["клик по координатам", s("input.click", { target: { by: "coords", x: 1, y: 2, space: "screen" } }), true],
    ["invoke по handle", s("ui.invoke", { target: { by: "handle", handle: "41" } }), true],
    ["setValue", s("ui.invoke", { target: { by: "handle", handle: "41" }, params: { pattern: "setValue", value: "x" } }), false],
    ["app.focus / wait", s("app.focus", { params: { app: "Telegram" } }), false],
    ["mouse down", s("input.mouse", { params: { op: "down" } }), true],
    ["незнакомое действие", s("x.y"), true],
  ])("%s → %s", (_n, step, want) => {
    expect(stepMayCommit(step)).toBe(want);
    expect(stepRetries({ ...step, retries: 3 })).toBe(want ? 0 : 3);
  });
});

describe("раннер: отказ рубежа — стоп без ретраев, данные наверх", () => {
  it("denied из executeStep → 1 попытка, outcome denied + data + stepIndex; «часть ушла» — stepActionInjected", async () => {
    const needsApproval = { signature: "click:отправить", process: "telegram", category: "messenger", what: "нажатие «отправить»" };
    const executeStep = vi.fn(async () => {
      throw new ActionError("§14: нужно «да» владельца", { code: "denied", data: { needsApproval }, injected: true });
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [s("app.focus"), s("input.type", { params: { text: "ок" }, retries: 4 })],
      cancel: { cancelled: false },
      actuator: { executeStep: vi.fn(async (st: SkillStep) => (st.action === "app.focus" ? undefined : executeStep())), checkExpect: async () => true, checkPrecondition: async () => true },
      sleep: async () => undefined,
    });
    expect(executeStep).toHaveBeenCalledTimes(1);
    const ar = outcomeToActionResult("c1", r, 1);
    expect(ar).toMatchObject({ ok: false, error: { code: "denied" }, data: { needsApproval }, stepIndex: 1, stepActionInjected: true });
  });
});

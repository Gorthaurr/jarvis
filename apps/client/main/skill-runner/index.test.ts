import { describe, expect, it, vi } from "vitest";
import type { SkillStep } from "@jarvis/protocol";
import { type CancelToken, type SkillActuator, runSkill } from "./index.js";

const noSleep = async () => undefined;

function step(action: string, extra: Partial<SkillStep> = {}): SkillStep {
  return { action, ...extra };
}

/** Мок-actuator: настраиваемое поведение execute/checkExpect. */
function mockActuator(over: Partial<SkillActuator> = {}): SkillActuator {
  return {
    executeStep: over.executeStep ?? vi.fn(async () => undefined),
    checkExpect: over.checkExpect ?? vi.fn(async () => true),
  };
}

describe("skill-runner (§8, §20)", () => {
  it("успешный прогон всех шагов", async () => {
    const actuator = mockActuator();
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("app.focus"), step("input.type", { expect: { role: "textbox" } })],
      cancel: { cancelled: false },
      actuator,
      sleep: noSleep,
    });
    expect(r.ok).toBe(true);
    expect(actuator.executeStep).toHaveBeenCalledTimes(2);
  });

  it("visual-expect (canvas/игра/видео): доходит до checkExpect; не подтвердился локально → эскалация к LLM (честно)", async () => {
    const escalate = vi.fn(async () => undefined);
    const seen: NonNullable<SkillStep["expect"]>[] = [];
    const checkExpect = vi.fn(async (e: NonNullable<SkillStep["expect"]>) => {
      seen.push(e);
      return e.kind !== "visual"; // visual локально не подтверждаем (нет OCR) → false → эскалация
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.click", { expect: { kind: "visual", text: "Победа" }, timeoutMs: 100, retries: 1 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ checkExpect }),
      escalate,
      sleep: noSleep,
    });
    expect(seen.some((e) => e.kind === "visual")).toBe(true); // visual-постусловие прошло через раннер
    expect(escalate).toHaveBeenCalledWith(expect.anything(), "exhausted"); // не подтвердил → к LLM (видит экран)
    expect(r.ok).toBe(false);
  });

  it("retry: expect не выполняется → повтор → успех", async () => {
    let calls = 0;
    const checkExpect = vi.fn(async () => {
      calls += 1;
      return calls >= 3; // первые опросы — нет, потом да
    });
    const execute = vi.fn(async () => undefined);
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("ui.invoke", { expect: { role: "button" }, timeoutMs: 150, retries: 3 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ checkExpect, executeStep: execute }),
      sleep: noSleep,
    });
    expect(r.ok).toBe(true);
    // re-ground: executeStep вызван более одного раза (повтор после неуспешного expect).
    expect(execute.mock.calls.length).toBeGreaterThan(1);
  });

  it("исчерпание retries → эскалация и failed с индексом шага", async () => {
    const escalate = vi.fn(async () => undefined);
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("ok"), step("ui.invoke", { expect: { role: "x" }, timeoutMs: 100, retries: 1 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ checkExpect: async () => false }),
      escalate,
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(r.failedStepIndex).toBe(1);
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ action: "ui.invoke" }), "exhausted");
  });

  it("отмена ПЕРЕД шагом останавливает ≤1 шага (§20)", async () => {
    const cancel: CancelToken = { cancelled: false };
    const execute = vi.fn(async () => {
      cancel.cancelled = true; // отмена приходит во время первого шага
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("a"), step("b"), step("c")],
      cancel,
      actuator: mockActuator({ executeStep: execute }),
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toBe("cancelled");
    expect(execute).toHaveBeenCalledTimes(1); // второй шаг не стартовал
  });

  it("needsLlm-шаг вызывает эскалацию needs_llm (§8)", async () => {
    const escalate = vi.fn(async () => ({ text: "x" }));
    await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.type", { needsLlm: true })],
      cancel: { cancelled: false },
      actuator: mockActuator(),
      escalate,
      sleep: noSleep,
    });
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ needsLlm: true }), "needs_llm");
  });

  it("needsLlm + эскалация ЗАПОЛНИЛА → params мёржатся в шаг, шаг исполняется (§8 tiered)", async () => {
    const escalate = vi.fn(async () => ({ text: "сочинённый ответ" }));
    let seenParams: Record<string, unknown> | undefined;
    const execute = vi.fn(async (_s: SkillStep, p?: Record<string, unknown>) => {
      seenParams = p;
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.type", { needsLlm: true, params: { text: "{{composed}}" } })],
      params: { base: 1 },
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute }),
      escalate,
      sleep: noSleep,
    });
    expect(r.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(seenParams).toEqual({ base: 1, text: "сочинённый ответ" }); // escalate-значения поверх skill-params
  });

  it("needsLlm + эскалация НЕ заполнила (void) → честный провал, шаг НЕ исполняется вслепую (§честность)", async () => {
    const escalate = vi.fn(async () => undefined);
    const execute = vi.fn(async () => undefined);
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.type", { needsLlm: true })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute }),
      escalate,
      sleep: noSleep,
    });
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ needsLlm: true }), "needs_llm");
    expect(r.ok).toBe(false);
    expect(r.failedStepIndex).toBe(0);
    expect(r.message).toMatch(/LLM/);
    expect(execute).not.toHaveBeenCalled(); // не исполнили вслепую
  });

  it("needsLlm БЕЗ хука escalate → честный провал (round-trip не подключён)", async () => {
    const execute = vi.fn(async () => undefined);
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.type", { needsLlm: true })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute }),
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});

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
    checkPrecondition: over.checkPrecondition ?? vi.fn(async () => true),
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
    // Wall-clock семантика (#1): время двигают модельные часы, expect подтверждается после повтора.
    let t = 0;
    const now = () => t;
    const sleepT = async (ms: number) => {
      t += ms;
    };
    const execute = vi.fn(async () => undefined);
    const checkExpect = vi.fn(async () => execute.mock.calls.length >= 2); // да — только после re-ground
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("ui.invoke", { expect: { role: "button" }, timeoutMs: 150, retries: 3 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ checkExpect, executeStep: execute }),
      now,
      sleep: sleepT,
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

  // Ревью Волны 3 (#2): реплей САМ честно останавливается по исчерпании бюджета — до серверного таймаута,
  // чтобы клиент не остался кликать параллельно LLM-петле («два писателя в GUI»).
  it("(#2) реплей останавливается по бюджету времени, не доводя до конца", async () => {
    let t = 0;
    const now = () => t;
    const execute = vi.fn(async () => {
      t += 40; // каждый шаг «съедает» 40мс модельного времени
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("a"), step("b"), step("c"), step("d")],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute }),
      deadlineMs: 100, // бюджет 100мс → успеют ~2 шага, дальше честный стоп
      now,
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/бюджет/);
    expect(execute.mock.calls.length).toBeLessThan(4); // не все шаги исполнены
  });

  // Ревью Волны 3 (#6): предусловие проверяется через checkPrecondition (активное окно + nameMode),
  // а НЕ checkExpect (тот фолбэкал на весь стол → ложный pass по фоновому окну).
  it("(#6) предусловие идёт через checkPrecondition; mismatch → честный стоп до исполнения", async () => {
    const checkPrecondition = vi.fn(async () => false); // предусловия нет в активном окне
    const execute = vi.fn(async () => undefined);
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.click", { precondition: { role: "button", name: "OK", nameMode: "exact" } })],
      cancel: { cancelled: false },
      actuator: mockActuator({ checkPrecondition, executeStep: execute }),
      sleep: noSleep,
    });
    expect(checkPrecondition).toHaveBeenCalledWith(expect.objectContaining({ role: "button", nameMode: "exact" }));
    expect(r.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled(); // слепого клика по изменившемуся экрану не было
  });

  // Ревью фиксов Волны 3 (#1): auto-wait ограничен WALL-CLOCK, а не числом поллов — один checkExpect
  // на UIA-слепом окне стоит до 12с, и счётчик «timeoutMs/100мс» растягивал ожидание в десятки раз.
  it("(#1) waitForExpect ограничен wall-clock, а не числом поллов (дорогой checkExpect)", async () => {
    let t = 0;
    const now = () => t;
    const sleepT = async (ms: number) => {
      t += ms;
    };
    const checkExpect = vi.fn(async () => {
      t += 3000; // «дорогой» UIA-опрос: 3с модельного времени на каждый вызов
      return false;
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("ui.invoke", { expect: { role: "button" }, timeoutMs: 10_000, retries: 0 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ checkExpect }),
      now,
      sleep: sleepT,
    });
    expect(r.ok).toBe(false);
    // Старый счётчик дал бы 100 опросов (10_000/100мс) = 300с; wall-clock — считанные единицы.
    expect(checkExpect.mock.calls.length).toBeLessThanOrEqual(5);
  });

  // Ревью фиксов Волны 3 (#1): остаток бюджета пересчитывается НА КАЖДОЙ попытке (после executeStep) —
  // снапшот таймаута с границы шага устаревал за долгую попытку и уводил клиент за серверный потолок.
  it("(#1) долгий executeStep не даёт expect-поллингу и ретраям выйти за дедлайн", async () => {
    let t = 0;
    const now = () => t;
    const sleepT = async (ms: number) => {
      t += ms;
    };
    const execute = vi.fn(async () => {
      t += 4000; // долгая попытка: 4с из бюджета 5с
    });
    const checkExpect = vi.fn(async () => {
      t += 2000;
      return false;
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("ui.invoke", { expect: { role: "button" }, timeoutMs: 60_000, retries: 5 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute, checkExpect }),
      deadlineMs: 5000,
      now,
      sleep: sleepT,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/бюджет/);
    // Попытка 1: executeStep 4с → остаток 1с → ОДИН опрос expect; попытка 2 не стартует (бюджет всё).
    expect(execute).toHaveBeenCalledTimes(1);
    expect(checkExpect).toHaveBeenCalledTimes(1);
    expect(t).toBeLessThan(10_000); // старый код поллил бы полный 60с-таймаут шага
  });

  // Ревью 2-го прохода (R3): executeStep съел ВЕСЬ бюджет → expect-опрос не выполняется ВОВСЕ
  // (один visual-опрос = скрин+OCR до ~20с — «обязательный опрос» раздувал хвост за серверный потолок).
  it("(R3) бюджет исчерпан после executeStep → опрос expect пропускается, честный стоп", async () => {
    let t = 0;
    const now = () => t;
    const sleepT = async (ms: number) => {
      t += ms;
    };
    const execute = vi.fn(async () => {
      t += 6000; // съел весь бюджет 5с
    });
    const checkExpect = vi.fn(async () => true);
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("ui.invoke", { expect: { kind: "visual", text: "Готово" }, timeoutMs: 60_000 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute, checkExpect }),
      deadlineMs: 5000,
      now,
      sleep: sleepT,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/бюджет/);
    expect(checkExpect).not.toHaveBeenCalled(); // дорогой OCR-опрос за пределами бюджета не запускался
  });

  // Ревью 2-го прохода (R3): retries из контента навыка клампится (сырое retries:99 не раздувает хвост).
  it("(R3) retries из контента клампится — не больше 6 попыток", async () => {
    const execute = vi.fn(async () => {
      throw new Error("мимо");
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.click", { target: { by: "coords", x: 1, y: 2, space: "screen" }, retries: 99 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute }),
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(execute.mock.calls.length).toBeLessThanOrEqual(6); // 1 + кламп 5 ретраев
  });
});

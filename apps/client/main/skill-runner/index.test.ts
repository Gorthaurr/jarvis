import { describe, expect, it, vi } from "vitest";
import type { SkillStep } from "@jarvis/protocol";
import { DrawingOverlayError } from "../selection/overlay-error.js";
import { type CancelToken, type SkillActuator, runSkill, outcomeToActionResult } from "./index.js";

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

describe("skill-runner × вуаль режима выделения (контроль-ревью 2026-09-05)", () => {
  it("шаг лёг об оверлей → без ретраев, причина в сообщении — «оверлей», а не «не подтвердил expect»", async () => {
    const execute = vi.fn(async () => {
      const e = new Error("Поверх экрана открыт оверлей режима выделения (уже 3 с) …");
      e.name = "DrawingOverlayError";
      throw e;
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.click", { target: { by: "coords", x: 1, y: 1 } as never, retries: 2 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute }),
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/оверлей/u);
    expect(r.message).not.toMatch(/не подтвердил expect/u);
    expect(execute).toHaveBeenCalledTimes(1);
    // Контроль-3: признак вуали доезжает до сервера СВОИМ кодом — иначе skill_execute/input_batch читались
    // как провал модели (эскалация тира), а авто-макрос объяснял «экран изменился».
    expect(r.overlayDrawing).toBe(true);
    expect(outcomeToActionResult("c", r, 1).error?.code).toBe("overlay_drawing");
    expect(outcomeToActionResult("c", { ok: false, message: "сайдкар не ответил" }, 1).error?.code).toBe("runtime");
  });

  it("обычная ошибка актуатора на последней попытке тоже называется в сообщении", async () => {
    const execute = vi.fn(async () => {
      throw new Error("сайдкар не ответил");
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.key", { params: { combo: "Enter" }, retries: 1 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute }),
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/сайдкар не ответил/u);
    expect(execute).toHaveBeenCalledTimes(2); // ретраи для обычных ошибок остаются
  });
});

describe("skill-runner × контроль-5 (действие ушло / протухшая причина / вуаль до предусловия)", () => {
  it("SEL-C5-1: причина ПОСЛЕДНЕЙ попытки — упавшая первая попытка не переживает вторую, которая исполнилась", async () => {
    let calls = 0;
    const execute = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("сайдкар не ответил");
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.key", { expect: { role: "button", name: "Отправлено" }, timeoutMs: 1, retries: 1 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute, checkExpect: vi.fn(async () => false) }),
      sleep: noSleep,
      overlayBlockReason: () => null,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/шаг 1 \(input\.key\) не подтвердил expect/u); // S2: нумерация 1-based, как у сервера
    expect(r.message).not.toMatch(/сайдкар не ответил/u); // Enter второй попытки УШЁЛ — «сайдкар лёг» вело бы к дублю
  });

  it("S1: вуаль поймала РЕТРАЙ — действие не инжектируется второй раз, наверх едет actionInjected (шаг мог выполниться)", async () => {
    const execute = vi.fn(async () => undefined);
    const overlayBlockReason = vi.fn().mockReturnValueOnce(null).mockReturnValue("Поверх экрана открыт оверлей режима выделения (уже 2 с)");
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.key", { expect: { role: "button", name: "Отправлено" }, timeoutMs: 1, retries: 2 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute, checkExpect: vi.fn(async () => false) }),
      sleep: noSleep,
      overlayBlockReason,
    });
    expect(execute).toHaveBeenCalledTimes(1); // ретрай под вуалью НЕ инжектирует Enter второй раз
    expect(r).toMatchObject({ ok: false, failedStepIndex: 0, overlayDrawing: true, actionInjected: true });
    expect(r.message).toMatch(/оверлей/u);
    const ar = outcomeToActionResult("c", r, 1);
    expect(ar.error?.code).toBe("overlay_drawing");
    expect(ar.stepActionInjected).toBe(true);
    // Без «ушло» признак не ставится — сервер не выдумывает неопределённость там, где её нет.
    expect(outcomeToActionResult("c", { ok: false, failedStepIndex: 0, overlayDrawing: true }, 1).stepActionInjected).toBeUndefined();
  });

  it("S1b: вуаль открылась между действием и сверкой постусловия → честный overlayDrawing + actionInjected, checkExpect не зовётся", async () => {
    const checkExpect = vi.fn(async () => true);
    // Контроль-6 (SR-C6-1): input.type под ОТКРЫТОЙ вуалью в актуатор не идёт вовсе — вуаль тут открывается ПОСЛЕ действия.
    let calls = 0;
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.type", { expect: { kind: "visual", text: "Привет" }, timeoutMs: 1 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ checkExpect }),
      sleep: noSleep,
      overlayBlockReason: () => (calls++ === 0 ? null : "Поверх экрана открыт оверлей режима выделения"),
    });
    expect(checkExpect).not.toHaveBeenCalled(); // OCR под вуалью прочитал бы «Обведите область», не результат
    expect(r).toMatchObject({ ok: false, overlayDrawing: true, actionInjected: true });
  });

  // ── контроль-6 ──
  it("client:C5R-1: вуаль ПОСРЕДИ сверки постусловия последней попытки → overlayDrawing + actionInjected, без ретрая и без «не подтвердил expect»", async () => {
    for (const retries of [0, undefined]) {
      const execute = vi.fn(async () => undefined);
      const checkExpect = vi.fn(async () => false); // OCR/UIA читали оверлей — постусловия «нет»
      const r = await runSkill({
        skillId: "s",
        version: 1,
        steps: [step("input.type", { params: { text: "Привет" }, expect: { kind: "visual", text: "Привет" }, timeoutMs: 1, ...(retries === undefined ? {} : { retries }) })],
        cancel: { cancelled: false },
        actuator: mockActuator({ executeStep: execute, checkExpect }),
        sleep: noSleep,
        overlayBlockReason: () => null, // к моменту решения вуаль уже закрылась — «сейчас открыт оверлей» сказать нельзя
        veiledSince: () => true, // …но в окне сверки она БЫЛА
      });
      expect(r, String(retries)).toMatchObject({ ok: false, failedStepIndex: 0, overlayDrawing: true, actionInjected: true });
      expect(r.message).toMatch(/вуал/u);
      expect(r.message).not.toMatch(/не подтвердил expect/u);
      expect(execute, String(retries)).toHaveBeenCalledTimes(1); // до фикса: ретрай инжектировал шаг ВТОРОЙ раз (дубль текста/Enter)
    }
  });

  it("client:C5R-1 (регресс-контроль): без вуали в окне сверки неуспешный expect по-прежнему ретраится и кончается «не подтвердил expect» с actionInjected", async () => {
    const execute = vi.fn(async () => undefined);
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.type", { params: { text: "Привет" }, expect: { kind: "visual", text: "Привет" }, timeoutMs: 1, retries: 1 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute, checkExpect: vi.fn(async () => false) }),
      sleep: noSleep,
      overlayBlockReason: () => null,
      veiledSince: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.overlayDrawing).toBeFalsy();
    expect(r.message).toMatch(/не подтвердил expect/u);
    expect(execute).toHaveBeenCalledTimes(2);
    // Контроль-6 (V5-3): действие УХОДИЛО — исход «не подтверждён», а не «не выполнено» (сервер: uncertain).
    expect(r.actionInjected).toBe(true);
    expect(outcomeToActionResult("c", r, 1).stepActionInjected).toBe(true);
  });

  it("V5-3: шаг, чьё действие НИ РАЗУ не ушло (executeStep падал каждый раз), НЕ несёт actionInjected", async () => {
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.key", { params: { combo: "Enter" }, retries: 1 })],
      cancel: { cancelled: false },
      actuator: mockActuator({
        executeStep: vi.fn(async () => {
          throw new Error("сайдкар не ответил");
        }),
      }),
      sleep: noSleep,
      overlayBlockReason: () => null,
    });
    expect(r.ok).toBe(false);
    expect(r.actionInjected).toBeFalsy();
  });

  it("SR-C6-1: шаг app.focus под вуалью НЕ идёт в актуатор (окно рисования потеряло бы фокус); негейченный ui.invoke — идёт", async () => {
    const execute = vi.fn(async () => undefined);
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("app.focus", { params: { app: "discord" } })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute }),
      sleep: noSleep,
      overlayBlockReason: () => "Поверх экрана открыт оверлей режима выделения",
    });
    expect(execute).not.toHaveBeenCalled(); // до фикса: attempt 0 шёл в actuator.executeStep → apps.focusApp
    expect(r).toMatchObject({ ok: false, failedStepIndex: 0, overlayDrawing: true });
    expect(r.actionInjected).toBeFalsy();
    const execute2 = vi.fn(async () => undefined);
    const r2 = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("ui.invoke", { target: { by: "handle", handle: "7" } as never })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute2 }),
      sleep: noSleep,
      overlayBlockReason: () => "Поверх экрана открыт оверлей режима выделения",
    });
    expect(execute2).toHaveBeenCalledTimes(1); // бесшумный invoke по handle мышь не трогает — его советует сам текст отказа
    expect(r2.ok).toBe(true);
  });

  it("client:C5R-2: гард точки инжекции бросил ПОСЛЕ ушедшего действия (печать под открывшейся вуалью) → actionInjected из ошибки", async () => {
    const execute = vi.fn(async () => {
      throw new DrawingOverlayError("Печать текста УЖЕ УШЛО в GUI, когда открылся оверлей", true);
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.type", { params: { text: "Привет" }, retries: 2 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute }),
      sleep: noSleep,
      overlayBlockReason: () => null,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, overlayDrawing: true, actionInjected: true });
    expect(outcomeToActionResult("c", r, 1).stepActionInjected).toBe(true);
  });

  // ── контроль-7 ──
  it("sensors-1: бюджет кончился ПОСЛЕ исполненной попытки (expect не опрошен) → actionInjected — иначе сервер велел бы «продолжай с k+1» про ушедший Enter", async () => {
    let t = 0;
    const execute = vi.fn(async () => {
      t += 50;
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.key", { params: { combo: "Enter" }, expect: { kind: "a11y", role: "text", name: "Отправлено" }, timeoutMs: 1000 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute, checkExpect: vi.fn(async () => false) }),
      sleep: noSleep,
      now: () => t,
      deadlineMs: 30,
      overlayBlockReason: () => null,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/бюджет/u);
    expect(r.actionInjected).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("sensors-1b: ретрай упёрся в бюджет ПОСЛЕ исполненной попытки 0 → actionInjected", async () => {
    let t = 0;
    const execute = vi.fn(async () => {
      t += 30;
    });
    const checkExpect = vi.fn(async () => {
      t += 80; // дорогой UIA-опрос съедает остаток
      return false;
    });
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.key", { params: { combo: "Enter" }, expect: { kind: "a11y", role: "text", name: "Отправлено" }, timeoutMs: 1000, retries: 2 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ executeStep: execute, checkExpect }),
      sleep: noSleep,
      now: () => t,
      deadlineMs: 100,
      overlayBlockReason: () => null,
      veiledSince: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/бюджет/u);
    expect(r.actionInjected).toBe(true); // попытка 0 нажала Enter
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("sensors-2: шаг wait ничего не инжектирует — непройденный expect без actionInjected; под вуалью — overlayDrawing без «ушло»", async () => {
    const plain = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("wait", { params: { ms: 1 }, expect: { kind: "a11y", role: "text", name: "x" }, timeoutMs: 1, retries: 0 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ checkExpect: vi.fn(async () => false) }),
      sleep: noSleep,
      overlayBlockReason: () => null,
      veiledSince: () => false,
    });
    expect(plain.ok).toBe(false);
    expect(plain.message).toMatch(/не подтвердил expect/u);
    expect(plain.actionInjected).toBeFalsy(); // до фикса: «Действие шага УХОДИЛО в GUI» про паузу
    const veiled = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("wait", { params: { ms: 1 }, expect: { kind: "a11y", role: "text", name: "x" }, timeoutMs: 1, retries: 0 })],
      cancel: { cancelled: false },
      actuator: mockActuator({ checkExpect: vi.fn(async () => false) }),
      sleep: noSleep,
      overlayBlockReason: () => "Поверх экрана открыт оверлей режима выделения",
    });
    expect(veiled).toMatchObject({ ok: false, overlayDrawing: true });
    expect(veiled.actionInjected).toBeFalsy();
  });

  it("runner-3: окно вуали для сверки постусловия — от начала ОПРОСА, а не от начала шага (вуаль, закрывшаяся во время executeStep, не делает честный «не подтвердил» сверкой под вуалью)", async () => {
    const seen: number[] = [];
    const t0 = Date.now();
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("ui.invoke", { target: { by: "handle", handle: "7" } as never, expect: { kind: "a11y", role: "text", name: "x" }, timeoutMs: 1, retries: 0 })],
      cancel: { cancelled: false },
      actuator: mockActuator({
        executeStep: async () => {
          await new Promise((res) => setTimeout(res, 25)); // бесшумный UIA-вызов идёт, пока владелец закрывает вуаль
        },
        checkExpect: vi.fn(async () => false),
      }),
      sleep: noSleep,
      overlayBlockReason: () => null,
      veiledSince: (t) => {
        seen.push(t);
        return false;
      },
    });
    expect(r.ok).toBe(false);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeGreaterThanOrEqual(t0 + 25); // до фикса: tExec взят ДО executeStep
  });

  it("SEL-C5-2: предусловие под вуалью — честная причина «оверлей», а не «экран изменился», без грундинга и без клика", async () => {
    const checkPrecondition = vi.fn(async () => false);
    const execute = vi.fn(async () => undefined);
    const r = await runSkill({
      skillId: "s",
      version: 1,
      steps: [step("input.click", { precondition: { role: "button", name: "OK" } })],
      cancel: { cancelled: false },
      actuator: mockActuator({ checkPrecondition, executeStep: execute }),
      sleep: noSleep,
      overlayBlockReason: () => "Поверх экрана открыт оверлей режима выделения",
    });
    expect(checkPrecondition).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, failedStepIndex: 0, overlayDrawing: true });
    expect(r.actionInjected).toBeFalsy(); // до действия дело не дошло
    expect(r.message).toMatch(/оверлей/u);
    expect(r.message).not.toMatch(/экран изменился/u);
  });
});

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

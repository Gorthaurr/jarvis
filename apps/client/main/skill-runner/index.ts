/**
 * Клиентский skill-runner — детерминированный интерпретатор шагов скилла (tier-0.5, §8).
 *
 * Навык — SkillStep[] в терминах интентов и ролей (НЕ координат/CSS). Runner проходит
 * шаги локально, без сети, быстро и бесплатно (механизм «$0 на переисполнении», §8/§15).
 * Сервер привлекается только если шаг needsLlm=true (сочинить текст) или при эскалации
 * после исчерпания retries.
 *
 * Каждый шаг (§6, §8, §20):
 *   - cancel-флаг проверяется ПЕРЕД каждым шагом (мгновенная отмена ≤1 шага, §20);
 *   - executeStep: ground + действие (ui.invoke основной путь / input.* fallback);
 *   - expect: постусловие — auto-wait (поллинг a11y) до наступления; по таймауту
 *     re-ground + retry; исчерпал retries → эскалация наверх.
 *
 * Actuator инъектируется (SkillActuator) — раннер декуплен от сайдкара и тестируем.
 */
import type { SkillStep, ActionResult } from "@jarvis/protocol";
import { DEFAULT_ACTION_TIMEOUT_MS } from "@jarvis/protocol";
import { createLogger, sleep as defaultSleep } from "@jarvis/shared";

const log = createLogger("skill-runner");

/** Исполнитель шагов и проверка постусловий — реализуется поверх actuators (сайдкар). */
export interface SkillActuator {
  /** Выполнить шаг (ground + действие). Бросает при ошибке. */
  executeStep(step: SkillStep, params?: Record<string, unknown>): Promise<void>;
  /** Проверить постусловие expect через a11y (один опрос; true = выполнено). */
  checkExpect(expect: NonNullable<SkillStep["expect"]>): Promise<boolean>;
}

/** Внешний сигнал отмены (§20). Проверяется перед каждым шагом. */
export interface CancelToken {
  cancelled: boolean;
}

/**
 * Хук эскалации к серверу (§8): needsLlm-шаг (сочинить значение по месту) или исчерпание retries.
 * Для "needs_llm" может ВЕРНУТЬ карту параметров — раннер мёржит её в params шага (это и есть
 * «дешёвая/сильная модель заполняет переменные на повторе»). void/ничего на needs_llm → раннер НЕ
 * исполняет шаг вслепую (закон честности), а честно валит его. Для "exhausted" результат не используется.
 */
export type EscalateFn = (
  step: SkillStep,
  reason: "needs_llm" | "exhausted",
) => Promise<Record<string, unknown> | void>;

/** Колбэк прогресса для task.status наверх (§20). */
export type ProgressFn = (stepIndex: number, total: number) => void;

export interface RunSkillOptions {
  skillId: string;
  version: number;
  steps: SkillStep[];
  params?: Record<string, unknown>;
  cancel: CancelToken;
  actuator: SkillActuator;
  onProgress?: ProgressFn;
  escalate?: EscalateFn;
  /** Инъекция паузы (тесты — мгновенная). */
  sleep?: (ms: number) => Promise<void>;
}

export interface SkillRunOutcome {
  ok: boolean;
  failedStepIndex?: number;
  message?: string;
}

const POLL_MS = 100;

/** Auto-wait постусловия (§8): поллим checkExpect до наступления или таймаута. */
async function waitForExpect(
  actuator: SkillActuator,
  expect: NonNullable<SkillStep["expect"]>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const maxPolls = Math.max(1, Math.floor(timeoutMs / POLL_MS));
  for (let i = 0; i < maxPolls; i += 1) {
    if (await actuator.checkExpect(expect)) return true;
    await sleep(POLL_MS);
  }
  return actuator.checkExpect(expect);
}

/** Прогнать навык (§8): cancel → execute → expect(auto-wait) → retry/re-ground → escalate. */
export async function runSkill(opts: RunSkillOptions): Promise<SkillRunOutcome> {
  const { steps, cancel, actuator, onProgress, escalate } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  log.info(`runSkill ${opts.skillId}@${opts.version}: ${steps.length} шагов`);

  for (let i = 0; i < steps.length; i += 1) {
    if (cancel.cancelled) {
      log.warn(`навык отменён на шаге ${i}`);
      return { ok: false, failedStepIndex: i, message: "cancelled" };
    }

    const step = steps[i];
    if (!step) continue;
    onProgress?.(i, steps.length);

    // needsLlm: значение шага сочиняется по месту (escalate → сервер/LLM). Раннер ИСПОЛЬЗУЕТ ответ —
    // мёржит карту параметров в params шага. Если эскалация не подключена / ничего не вернула, шаг
    // НЕ исполняется вслепую (иначе ушёл бы незаполненный плейсхолдер → ложный результат, §честность),
    // а честно валится. exhausted-эскалация (ниже) — терминальная, её результат не используется.
    let stepParams = opts.params;
    if (step.needsLlm) {
      const resolved = escalate ? await escalate(step, "needs_llm") : undefined;
      if (!resolved || typeof resolved !== "object") {
        log.warn(`шаг ${i} (${step.action}): needsLlm не заполнен эскалацией — честный провал, не исполняю вслепую`);
        return { ok: false, failedStepIndex: i, message: `шаг ${i} (${step.action}) требует LLM, но заполнение недоступно` };
      }
      stepParams = { ...(opts.params ?? {}), ...resolved };
    }

    const retries = step.retries ?? 2;
    const timeoutMs = step.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    let attempt = 0;
    let stepOk = false;

    while (attempt <= retries) {
      if (cancel.cancelled) return { ok: false, failedStepIndex: i, message: "cancelled" };
      try {
        await actuator.executeStep(step, stepParams); // ground + действие (re-ground при повторе)
        stepOk = step.expect ? await waitForExpect(actuator, step.expect, timeoutMs, sleep) : true;
      } catch (e) {
        log.warn(`шаг ${i} попытка ${attempt} упала: ${e instanceof Error ? e.message : String(e)}`);
        stepOk = false;
      }
      if (stepOk) break;
      attempt += 1;
      if (attempt <= retries) await sleep(200 * attempt);
    }

    if (!stepOk) {
      await escalate?.(step, "exhausted");
      return { ok: false, failedStepIndex: i, message: `шаг ${i} (${step.action}) не подтвердил expect` };
    }
  }

  onProgress?.(steps.length, steps.length);
  return { ok: true };
}

/** Маппинг итога навыка в ActionResult (для dispatch при skill.execute, M4). */
export function outcomeToActionResult(
  commandId: string,
  outcome: SkillRunOutcome,
  durationMs: number,
): ActionResult {
  if (outcome.ok) return { commandId, ok: true, durationMs };
  return {
    commandId,
    ok: false,
    error: { code: "runtime", message: outcome.message ?? "skill failed" },
    stepIndex: outcome.failedStepIndex,
    durationMs,
  };
}

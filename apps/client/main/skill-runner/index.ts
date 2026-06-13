/**
 * Клиентский skill-runner — детерминированный интерпретатор шагов скилла (tier-0.5, §8).
 *
 * Идея (§8): навык хранится как SkillStep[] в терминах интентов и ролей (НЕ координат/CSS).
 * Runner проходит шаги локально, без сети, БЫСТРО и БЕСПЛАТНО. Сервер привлекается только если
 * шаг помечен needsLlm=true (сочинить текст по месту) или при эскалации после исчерпания retries.
 *
 * Каждый шаг (§6, §8):
 *   - ground: найти цель по role/name (a11y-first);
 *   - действие: ui.invoke (основной путь) или input.* (fallback);
 *   - expect: постусловие — runner поллит a11y до наступления (auto-wait), по таймауту
 *     re-ground + retry; исчерпал retries -> эскалация (вернуть failed наверх).
 *   - cancel-флаг (§20): проверяется ПЕРЕД каждым шагом — мгновенная отмена задачи.
 *
 * Скелет содержит реальную структуру цикла; конкретные actuator-вызовы — за интерфейсом.
 * // TODO(M4): подключить реальные ground/invoke/input через сайдкар (actuators/ground|input)
 *   и реальный a11y-полл expect.
 */
import type { SkillStep, ActionResult } from "@jarvis/protocol";
import { DEFAULT_ACTION_TIMEOUT_MS } from "@jarvis/protocol";
import { createLogger, sleep } from "@jarvis/shared";

const log = createLogger("skill-runner");

/** Внешний сигнал отмены (§20). Проверяется перед каждым шагом. */
export interface CancelToken {
  cancelled: boolean;
}

/** Хук эскалации к серверу: needsLlm-шаг или исчерпание retries (§8). */
export type EscalateFn = (step: SkillStep, reason: "needs_llm" | "exhausted") => Promise<void>;

/** Колбэк прогресса для task.status наверх (§20). */
export type ProgressFn = (stepIndex: number, total: number) => void;

export interface RunSkillOptions {
  skillId: string;
  version: number;
  steps: SkillStep[];
  params?: Record<string, unknown>;
  cancel: CancelToken;
  onProgress?: ProgressFn;
  escalate?: EscalateFn;
}

/** Итог выполнения навыка — попадает в ActionResult на skill.execute (stepIndex при ошибке). */
export interface SkillRunOutcome {
  ok: boolean;
  failedStepIndex?: number;
  message?: string;
}

/** Полл постусловия expect через a11y (§8 auto-wait). */
// TODO(M4): реализовать через actuators/ground (сайдкар UIA).
async function waitForExpect(_expect: NonNullable<SkillStep["expect"]>, _timeoutMs: number): Promise<boolean> {
  // Скелет: пока постусловия не проверяются — возвращаем false (любой expect-шаг «не подтверждён»).
  // Это намеренно: на M0/M1 skill.execute честно недоступен (dispatch вернёт not implemented M4).
  return false;
}

/** Выполнить один шаг (ground/invoke/type/...). */
// TODO(M4): диспатчить step.action в реальные actuator-вызовы.
async function executeStep(step: SkillStep): Promise<void> {
  log.debug(`(stub) execute step action=${step.action} target=${JSON.stringify(step.target ?? null)}`);
  // Скелет без побочных эффектов: реальные действия добавятся в M4.
}

/**
 * Прогнать навык. Реальная структура цикла §8 (cancel -> ground -> act -> expect -> retry/escalate).
 */
export async function runSkill(opts: RunSkillOptions): Promise<SkillRunOutcome> {
  const { steps, cancel, onProgress, escalate } = opts;
  log.info(`runSkill ${opts.skillId}@${opts.version}: ${steps.length} шагов`);

  for (let i = 0; i < steps.length; i++) {
    // §20: отмена проверяется ПЕРЕД каждым шагом — гарантированная остановка.
    if (cancel.cancelled) {
      log.warn(`навык отменён на шаге ${i}`);
      return { ok: false, failedStepIndex: i, message: "cancelled" };
    }

    const step = steps[i];
    if (!step) continue;
    onProgress?.(i, steps.length);

    // needsLlm — единственный штатный повод дернуть сервер (§8): сочинить текст по месту.
    if (step.needsLlm) {
      await escalate?.(step, "needs_llm");
    }

    const retries = step.retries ?? 2;
    const timeoutMs = step.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    let attempt = 0;
    let stepOk = false;

    // Цикл retry с re-ground (§8).
    while (attempt <= retries) {
      if (cancel.cancelled) return { ok: false, failedStepIndex: i, message: "cancelled" };
      try {
        await executeStep(step); // включает (в M4) ground + действие

        if (step.expect) {
          // auto-wait постусловия; по таймауту -> повтор (re-ground на следующей итерации).
          stepOk = await waitForExpect(step.expect, timeoutMs);
        } else {
          // Шаг без expect — «слепой клик» (§8): допустим лишь там, где постусловие невыразимо.
          stepOk = true;
        }
      } catch (e) {
        log.warn(`шаг ${i} попытка ${attempt} упала: ${e instanceof Error ? e.message : String(e)}`);
        stepOk = false;
      }

      if (stepOk) break;
      attempt += 1;
      if (attempt <= retries) await sleep(200 * attempt); // короткий backoff перед re-ground
    }

    if (!stepOk) {
      // Исчерпали retries -> эскалация наверх (сервер решит: vision-fallback / пересборка плана, §8).
      await escalate?.(step, "exhausted");
      return { ok: false, failedStepIndex: i, message: `шаг ${i} (${step.action}) не подтвердил expect` };
    }
  }

  onProgress?.(steps.length, steps.length);
  return { ok: true };
}

/** Удобный маппинг итога навыка в ActionResult (для dispatch при включении skill.execute в M4). */
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

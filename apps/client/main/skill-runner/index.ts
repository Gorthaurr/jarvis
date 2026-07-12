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
  /**
   * §Волна3 ревью (#6): проверить ПРЕДУСЛОВИЕ шага — элемент присутствует В АКТИВНОМ ОКНЕ (scope="active",
   * без фолбэка на весь стол) с учётом nameMode. Отдельный метод от checkExpect: тот падал на весь стол
   * (кнопка «OK» в фоновом окне давала ложный pass) и терял nameMode из протокола.
   */
  checkPrecondition(pre: NonNullable<SkillStep["precondition"]>): Promise<boolean>;
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
  /**
   * §Волна3 ревью (#2): общий БЮДЖЕТ времени на весь реплей (мс от старта). Реплей САМ честно
   * останавливается по исчерпании — до того, как серверный sendAction-таймаут сдастся и запустит
   * LLM-петлю ПАРАЛЛЕЛЬНО ещё идущему реплею («два писателя в GUI»). Проверяется перед каждым шагом
   * и ограничивает auto-wait постусловия остатком бюджета. Без него — как раньше (без границы).
   */
  deadlineMs?: number;
  /** Инъекция часов (тесты). */
  now?: () => number;
}

export interface SkillRunOutcome {
  ok: boolean;
  failedStepIndex?: number;
  message?: string;
}

const POLL_MS = 100;

/**
 * Auto-wait постусловия (§8): поллим checkExpect до наступления или таймаута.
 * Ревью фиксов Волны 3 (#1): граница — WALL-CLOCK, не число поллов. Один checkExpect на UIA-слепом
 * окне может занимать до 12с (сайдкар-таймаут): счётчик «timeoutMs/100мс» поллов растягивал ожидание
 * в десятки раз за бюджет реплея. Минимум один опрос делаем всегда (успевший исполниться шаг честно
 * подтверждается), дальше — только пока не вышло время; перебег ≤ длительности одного checkExpect.
 */
async function waitForExpect(
  actuator: SkillActuator,
  expect: NonNullable<SkillStep["expect"]>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<boolean> {
  const startedAt = now();
  for (;;) {
    if (await actuator.checkExpect(expect)) return true;
    if (now() - startedAt + POLL_MS >= timeoutMs) return false;
    await sleep(POLL_MS);
  }
}

/** Прогнать навык (§8): cancel → execute → expect(auto-wait) → retry/re-ground → escalate. */
export async function runSkill(opts: RunSkillOptions): Promise<SkillRunOutcome> {
  const { steps, cancel, actuator, onProgress, escalate } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const budgetLeft = (): number => (opts.deadlineMs ? opts.deadlineMs - (now() - startedAt) : Number.POSITIVE_INFINITY);
  log.info(`runSkill ${opts.skillId}@${opts.version}: ${steps.length} шагов`);

  for (let i = 0; i < steps.length; i += 1) {
    if (cancel.cancelled) {
      log.warn(`навык отменён на шаге ${i}`);
      return { ok: false, failedStepIndex: i, message: "cancelled" };
    }
    // §Волна3 ревью (#2): исчерпан бюджет реплея → ЧЕСТНЫЙ стоп ДО серверного таймаута (клиент не
    // остаётся кликать параллельно LLM-петле). Обычная петля добьёт задачу с контекстом «дошёл до N».
    if (budgetLeft() <= 0) {
      log.warn(`навык остановлен по бюджету времени на шаге ${i}`);
      return { ok: false, failedStepIndex: i, message: `реплей не уложился в бюджет времени (шаг ${i})` };
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

    // §Волна3 (3.3, паттерн UFO2): ПРЕДУСЛОВИЕ шага — живой UIA-стейт проверяется ДО исполнения.
    // Mismatch (экран изменился, элемента нет) → честный стоп с частичным результатом, а не слепой
    // клик по ушедшему состоянию; модель получает «дошёл до шага N» и делает один репланинг-раунд.
    if (step.precondition) {
      const pre = step.precondition;
      // §Волна3 ревью (#6): проверка В АКТИВНОМ ОКНЕ с nameMode (не checkExpect — тот фолбэкал на весь
      // стол → ложный pass по фоновому окну, и терял nameMode).
      const preOk = await actuator.checkPrecondition(pre);
      if (!preOk) {
        log.warn(`шаг ${i}: предусловие не выполнено (${pre.role}${pre.name ? ` «${pre.name}»` : ""}) — стоп`);
        return {
          ok: false,
          failedStepIndex: i,
          message: `шаг ${i} (${step.action}): предусловие не выполнено — ${pre.role}${pre.name ? ` «${pre.name}»` : ""} не найден (экран изменился)`,
        };
      }
    }

    // Ревью фиксов, 2-й проход (R3): retries из контента навыка клампим — без капа sleep(200·attempt)
    // между попытками раздувал хвостовой перебег за серверный потолок 130с.
    const retries = Math.max(0, Math.min(5, step.retries ?? 2));
    let attempt = 0;
    let stepOk = false;

    while (attempt <= retries) {
      if (cancel.cancelled) return { ok: false, failedStepIndex: i, message: "cancelled" };
      if (budgetLeft() <= 0) return { ok: false, failedStepIndex: i, message: `реплей не уложился в бюджет времени (шаг ${i})` };
      try {
        await actuator.executeStep(step, stepParams); // ground + действие (re-ground при повторе)
        // §Волна3 ревью (#2) + ревью фиксов (#1): auto-wait постусловия ограничен ОСТАТКОМ бюджета,
        // пересчитанным ЗДЕСЬ (после executeStep, на каждой попытке) — снапшот с границы шага
        // устаревал за долгую попытку, и ретрай поллил полный чужой таймаут за пределами бюджета.
        // Ревью фиксов, 2-й проход (R3): бюджет исчерпан ПОСЛЕ executeStep → опрос НЕ делаем вовсе
        // (один visual-опрос = скрин+OCR до ~20с — «обязательный опрос» раздувал хвост за потолок);
        // честный стоп по бюджету, модель всё равно сверяет исход глазами после реплея.
        const expectTimeoutMs = Math.min(step.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, budgetLeft());
        if (step.expect && expectTimeoutMs <= 0) {
          return { ok: false, failedStepIndex: i, message: `реплей не уложился в бюджет времени (шаг ${i}, сверка постусловия не выполнялась)` };
        }
        stepOk = step.expect ? await waitForExpect(actuator, step.expect, expectTimeoutMs, sleep, now) : true;
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

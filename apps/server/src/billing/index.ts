/**
 * SpendGuard — учёт расходов и предохранители (§14).
 *
 * Реальная логика лимитов работает in-memory (без БД тоже): spend cap, kill-switch,
 * максимум шагов и токенов на задачу (защита от бесконечного цикла агента).
 * Персистентность usage_quota — через pg (best-effort); без БД счётчики живут
 * в памяти процесса и сбрасываются при рестарте.
 *
 * §0 принцип 5: здесь НЕТ и не должно быть карточных/платёжных данных — только
 * учёт стоимости вызовов LLM и счётчики шагов.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { query } from "../db/pool.js";

const log: Logger = createLogger("billing");

/** Лимиты, применяемые SpendGuard. */
export interface SpendLimits {
  /** Потолок трат за период, в валюте бюджета (напр. рубли/USD). */
  spendCap: number;
  /** Максимум шагов агента на одну задачу (предохранитель цикла, §14). */
  maxStepsPerTask: number;
  /** Максимум токенов на одну задачу. */
  maxTokensPerTask: number;
}

export const DEFAULT_LIMITS: SpendLimits = {
  spendCap: 50,
  maxStepsPerTask: 30,
  maxTokensPerTask: 200_000,
};

/** Причина отказа предохранителя. */
export type GuardDenyReason =
  | "kill_switch"
  | "spend_cap"
  | "max_steps"
  | "max_tokens";

export interface GuardDecision {
  allowed: boolean;
  reason?: GuardDenyReason;
  message?: string;
}

/** Накопленные показатели одной задачи. */
interface TaskMeter {
  steps: number;
  tokens: number;
}

export class SpendGuard {
  private readonly limits: SpendLimits;
  /** Суммарные траты за период (in-memory зеркало usage_quota). */
  private spent = 0;
  /** Глобальный стоп: ни один платный вызов не проходит (§14). */
  private killSwitch = false;
  /** Счётчики по задачам. */
  private readonly tasks = new Map<string, TaskMeter>();

  constructor(limits: Partial<SpendLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Активировать аварийный стоп (§14): дальнейшие платные операции запрещены. */
  engageKillSwitch(): void {
    this.killSwitch = true;
    log.warn("kill-switch активирован — платные операции заблокированы");
  }

  releaseKillSwitch(): void {
    this.killSwitch = false;
    log.info("kill-switch снят");
  }

  get isKilled(): boolean {
    return this.killSwitch;
  }

  get totalSpent(): number {
    return this.spent;
  }

  /**
   * Проверить, можно ли выполнить очередной платный шаг задачи (§14).
   * Не списывает — только проверяет. Списание — record* после факта.
   */
  check(taskId: string, estimatedCost = 0, estimatedTokens = 0): GuardDecision {
    if (this.killSwitch) {
      return deny("kill_switch", "аварийный стоп активен");
    }
    if (this.spent + estimatedCost > this.limits.spendCap) {
      return deny("spend_cap", `превышен потолок трат (${this.limits.spendCap})`);
    }
    const meter = this.meter(taskId);
    if (meter.steps + 1 > this.limits.maxStepsPerTask) {
      return deny("max_steps", `превышен лимит шагов задачи (${this.limits.maxStepsPerTask})`);
    }
    if (meter.tokens + estimatedTokens > this.limits.maxTokensPerTask) {
      return deny("max_tokens", `превышен лимит токенов задачи (${this.limits.maxTokensPerTask})`);
    }
    return { allowed: true };
  }

  /** Зафиксировать один выполненный шаг задачи. */
  recordStep(taskId: string): void {
    this.meter(taskId).steps += 1;
  }

  /** Зафиксировать потраченные токены и стоимость. */
  recordUsage(taskId: string, tokens: number, cost: number): void {
    const meter = this.meter(taskId);
    meter.tokens += Math.max(0, tokens);
    this.spent += Math.max(0, cost);
    // Персистентность usage_quota — best-effort (§14).
    void this.persistUsage(tokens, cost);
  }

  /** Сбросить счётчики задачи по её завершении. */
  finishTask(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /** Остаток до потолка трат. */
  get remainingCap(): number {
    return Math.max(0, this.limits.spendCap - this.spent);
  }

  private meter(taskId: string): TaskMeter {
    let m = this.tasks.get(taskId);
    if (!m) {
      m = { steps: 0, tokens: 0 };
      this.tasks.set(taskId, m);
    }
    return m;
  }

  private async persistUsage(tokens: number, cost: number): Promise<void> {
    const res = await query(
      `insert into usage_quota (tokens, cost, at) values ($1, $2, now())`,
      [tokens, cost],
    );
    if (!res) log.debug("usage_quota no-op (нет БД) — учёт только in-memory");
  }
}

function deny(reason: GuardDenyReason, message: string): GuardDecision {
  return { allowed: false, reason, message };
}

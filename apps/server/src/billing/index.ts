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
  /** id юзера для персиста usage_quota (§13, PK user_id+period); без него — только in-memory. */
  private readonly userId: string | undefined;
  private readonly now: () => number;
  /** Период ('YYYY-MM'), к которому относится текущий `spent`: смена месяца → сброс (§14). */
  private periodKey: string;
  /** Последний best-effort персист — для drain() (graceful shutdown / тесты). */
  private lastPersist: Promise<void> = Promise.resolve();

  constructor(limits: Partial<SpendLimits> = {}, opts: { userId?: string; now?: () => number } = {}) {
    // САНИТИЗАЦИЯ лимитов (§14): нечисловой лимит (напр. DEFAULT_SPEND_CAP с битым env →
    // Number.parseFloat → NaN) сделал бы предикат `spent+cost > NaN` всегда false → предохранитель
    // молча выключен. Любой не-конечный лимит → дефолт.
    const merged = { ...DEFAULT_LIMITS, ...limits };
    this.limits = {
      spendCap: Number.isFinite(merged.spendCap) ? merged.spendCap : DEFAULT_LIMITS.spendCap,
      maxStepsPerTask: Number.isFinite(merged.maxStepsPerTask) ? merged.maxStepsPerTask : DEFAULT_LIMITS.maxStepsPerTask,
      maxTokensPerTask: Number.isFinite(merged.maxTokensPerTask) ? merged.maxTokensPerTask : DEFAULT_LIMITS.maxTokensPerTask,
    };
    this.userId = opts.userId;
    this.now = opts.now ?? (() => Date.now());
    this.periodKey = this.currentPeriod();
  }

  /**
   * Сброс счётчика трат на смене месяца (§14): spendCap — потолок ЗА ПЕРИОД ('YYYY-MM'). Без
   * сброса долгоживущий процесс на новом месяце нёс бы накопленное прошлого → ложно резал бы.
   */
  private rolloverIfNeeded(): void {
    const p = this.currentPeriod();
    if (p !== this.periodKey) {
      log.info("SpendGuard: новый период — счётчик трат сброшен", { from: this.periodKey, to: p });
      this.periodKey = p;
      this.spent = 0;
    }
  }

  /**
   * Подтянуть накопленные траты за ТЕКУЩИЙ период из usage_quota (§14). Без этого рестарт
   * (краш/деплой/OOM) обнуляет `spent` → месячный потолок обходится именно когда нужнее. Звать
   * на старте ДО первого check(). Best-effort: без userId/БД — no-op, не роняет старт.
   */
  async hydrate(): Promise<void> {
    if (!this.userId) return;
    this.periodKey = this.currentPeriod(); // гидрируем именно текущий период
    try {
      const res = await query(
        "select cost_estimate from usage_quota where user_id = $1 and period = $2",
        [this.userId, this.currentPeriod()],
      );
      const prior = res?.rows?.[0] ? Number(res.rows[0].cost_estimate) : 0;
      if (Number.isFinite(prior) && prior > 0) {
        this.spent = prior;
        log.info("SpendGuard: траты периода восстановлены из usage_quota", { spent: this.spent, period: this.currentPeriod() });
      }
    } catch (e) {
      log.debug("SpendGuard.hydrate пропущен", e instanceof Error ? e.message : String(e));
    }
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
    this.rolloverIfNeeded();
    if (this.killSwitch) {
      return deny("kill_switch", "аварийный стоп активен");
    }
    // Нечисловую оценку трактуем как 0 (не отключаем предохранитель сравнением с NaN).
    const ec = Number.isFinite(estimatedCost) ? estimatedCost : 0;
    const et = Number.isFinite(estimatedTokens) ? estimatedTokens : 0;
    if (this.spent + ec > this.limits.spendCap) {
      return deny("spend_cap", `превышен потолок трат (${this.limits.spendCap})`);
    }
    const meter = this.meter(taskId);
    if (meter.steps + 1 > this.limits.maxStepsPerTask) {
      return deny("max_steps", `превышен лимит шагов задачи (${this.limits.maxStepsPerTask})`);
    }
    if (meter.tokens + et > this.limits.maxTokensPerTask) {
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
    this.rolloverIfNeeded();
    // САНИТИЗАЦИЯ: NaN (провайдер не вернул usage / стрим оборвался → estimateCost=NaN) иначе
    // делает spent/tokens навсегда NaN → предохранители молча отключаются. Не-конечное → 0.
    const t = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
    const c = Number.isFinite(cost) ? Math.max(0, cost) : 0;
    const meter = this.meter(taskId);
    meter.tokens += t;
    this.spent += c;
    // Персистентность usage_quota — best-effort (§14); промис ловим в drain().
    this.lastPersist = this.persistUsage(t, c);
    void this.lastPersist;
  }

  /** Дождаться завершения последнего best-effort персиста (graceful shutdown / тесты). */
  async drain(): Promise<void> {
    await this.lastPersist;
  }

  /** Сбросить счётчики задачи по её завершении. */
  finishTask(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /** Остаток до потолка трат. */
  get remainingCap(): number {
    return Math.max(0, this.limits.spendCap - this.spent);
  }

  /** Снимок расхода/лимитов периода (§6B/B5) — read-only для вкладки «Оплата». */
  snapshot(): { period: string; spent: number; cap: number; remaining: number; killSwitch: boolean } {
    this.rolloverIfNeeded();
    return {
      period: this.periodKey,
      spent: this.spent,
      cap: this.limits.spendCap,
      remaining: this.remainingCap,
      killSwitch: this.killSwitch,
    };
  }

  private meter(taskId: string): TaskMeter {
    let m = this.tasks.get(taskId);
    if (!m) {
      m = { steps: 0, tokens: 0 };
      this.tasks.set(taskId, m);
    }
    return m;
  }

  /** Текущий период учёта 'YYYY-MM' (§13). */
  private currentPeriod(): string {
    return new Date(this.now()).toISOString().slice(0, 7);
  }

  /**
   * Best-effort персист в usage_quota (§13, §14): upsert по (user_id, period),
   * аккумулирует tokens_used/cost_estimate. Без userId или БД — no-op (in-memory учёт).
   */
  private async persistUsage(tokens: number, cost: number): Promise<void> {
    if (!this.userId) return; // без юзера — только in-memory зеркало
    const res = await query(
      `insert into usage_quota (user_id, period, tokens_used, cost_estimate)
       values ($1, $2, $3, $4)
       on conflict (user_id, period) do update
         set tokens_used   = usage_quota.tokens_used + excluded.tokens_used,
             cost_estimate = usage_quota.cost_estimate + excluded.cost_estimate,
             updated_at    = now()`,
      [this.userId, this.currentPeriod(), Math.max(0, tokens), Math.max(0, cost)],
    );
    if (!res) log.debug("usage_quota no-op (нет БД) — учёт только in-memory");
  }
}

function deny(reason: GuardDenyReason, message: string): GuardDecision {
  return { allowed: false, reason, message };
}

/**
 * Реестр SpendGuard ПО userId (§6B/B5 мультитенант). РАНЬШЕ был ОДИН глобальный SpendGuard без userId
 * → (1) траты ВСЕХ юзеров мешались в один счётчик (один тенант исчерпывал потолок на всех) и
 * (2) persist usage_quota был МЁРТВ (persistUsage/hydrate — no-op без userId), т.е. потолок периода
 * обнулялся каждым рестартом. Теперь — по гварду на пользователя (ленивая Map), каждый персистит свой
 * usage_quota по (user_id, period). Лимиты/now общие (платформенный дефолт), userId — на гвард.
 */
export class SpendGuards {
  private readonly guards = new Map<string, SpendGuard>();

  constructor(
    private readonly limits: Partial<SpendLimits> = {},
    private readonly opts: { now?: () => number } = {},
  ) {}

  /** Гвард пользователя (ленивое создание). */
  forUser(userId: string): SpendGuard {
    let g = this.guards.get(userId);
    if (!g) {
      g = new SpendGuard(this.limits, { userId, now: this.opts.now });
      this.guards.set(userId, g);
    }
    return g;
  }

  /** Гидрировать траты текущего периода пользователя из usage_quota (звать в handshake до первого check). */
  async hydrate(userId: string): Promise<void> {
    await this.forUser(userId).hydrate();
  }

  /** Дождаться best-effort персиста всех гвардов (graceful shutdown). */
  async drainAll(): Promise<void> {
    await Promise.all([...this.guards.values()].map((g) => g.drain().catch(() => {})));
  }

  /** Снимок расхода/лимитов пользователя (§6B/B5) для вкладки «Оплата». */
  snapshot(userId: string): { period: string; spent: number; cap: number; remaining: number; killSwitch: boolean } {
    return this.forUser(userId).snapshot();
  }

  /**
   * Снимки расхода ВСЕХ известных юзеров (для COGS-дашборда `GET /cogs`). Только пользователи,
   * по которым в этом процессе был хотя бы один вызов (ленивая Map forUser). `spent` теперь —
   * фактическая стоимость per-model (после фикса единого costUsd), а не Haiku-заниженная.
   */
  allSnapshots(): Array<{ userId: string; period: string; spent: number; cap: number; remaining: number; killSwitch: boolean }> {
    return [...this.guards.entries()].map(([userId, g]) => ({ userId, ...g.snapshot() }));
  }
}

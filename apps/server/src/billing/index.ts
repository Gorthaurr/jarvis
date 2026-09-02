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
  // ⚠️ Предохранители ЗАДАЧИ не должны быть ЖЁСТЧЕ петлевого потолка HARD_STEP_CAP=50 (agent/index.ts):
  //  иначе SpendGuard рубит легитимную длинную задачу РАНЬШЕ её собственного лимита и врёт «достигнут
  //  лимит» на полпути (было maxStepsPerTask=30 < 50 → многошаговая GUI/веб-задача с циклами
  //  inspect→act→verify обрывалась на 30-м раунде). Выровнено на 50; токены — с запасом под 50 раундов
  //  с vision/inspect-снимками (uncached input+output на задачу). spendCap здесь — платформенный дефолт,
  //  реально задаётся config.defaultSpendCap ($300, env DEFAULT_SPEND_CAP).
  spendCap: 300,
  maxStepsPerTask: 50,
  maxTokensPerTask: 500_000,
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

/** Порог квоты, пересечённый при записи расхода: 80% (soft) / 100% (hard). */
export type ThresholdKind = "soft" | "hard";

export class SpendGuard {
  private limits: SpendLimits;
  /** Доля потолка, на которой срабатывает soft-порог (продуктовые квоты; деф 80%). */
  private softPct = 80;
  private thresholdCbs: Array<(kind: ThresholdKind, pct: number) => void> = [];
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
   *
   * МОНОТОННОСТЬ (M3, гонка reconnect): hydrate зовётся не только на boot, но на КАЖДОМ
   * handshake/reconnect. Безусловная перезапись `this.spent = prior` откатывала бы назад живой
   * in-memory spent, если reconnect пришёл сразу после recordUsage (персист fire-and-forget ещё
   * не долетел до БД или гонка чтения) — прочитали бы stale и обнулили только что учтённый расход,
   * обходя spend cap. Берём max(живое, из БД) — гидрация двигает счётчик только ВПЕРЁД.
   */
  async hydrate(opts?: { source?: "estimate" | "ledger" }): Promise<void> {
    if (!this.userId) return;
    // Смена месяца между reconnect'ами: прямое присваивание periodKey оставляло spent ПРОШЛОГО периода в новом
    // (контроль-ревью 2026-09-02: пользователь начинал месяц с исчерпанной квотой) — сначала rollover.
    this.rolloverIfNeeded();
    // Продукт: источник — точный ledger (cost_micro, целые µ$). cost_estimate (NUMERIC 12,2) округляет КАЖДЫЙ
    // раунд до цента и на мелких ходах систематически завышает (100 × $0.006 → $1.00 вместо $0.60).
    const ledger = opts?.source === "ledger";
    try {
      const res = await query(
        ledger ? "select cost_micro from usage_quota where user_id = $1 and period = $2" : "select cost_estimate from usage_quota where user_id = $1 and period = $2",
        [this.userId, this.currentPeriod()],
      );
      const raw = res?.rows?.[0] ? Number(ledger ? res.rows[0].cost_micro : res.rows[0].cost_estimate) : 0;
      const prior = ledger ? raw / 1e6 : raw;
      if (Number.isFinite(prior) && prior > 0 && prior > this.spent) {
        this.spent = prior;
        log.info("SpendGuard: траты периода восстановлены из usage_quota", { spent: this.spent, period: this.currentPeriod() });
      }
    } catch (e) {
      log.debug("SpendGuard.hydrate пропущен", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * ПРОДУКТОВЫЙ РЕЖИМ (2026-09-02): лимиты из плана пользователя (QuotaResolver) вместо платформенного
   * дефолта. Не-конечные значения игнорируются (та же санитизация, что в конструкторе). При мастер-флаге 0
   * никто это не зовёт — лимиты остаются как сегодня.
   */
  setLimits(patch: Partial<SpendLimits> & { softPct?: number }): void {
    const next = { ...this.limits };
    if (Number.isFinite(patch.spendCap)) next.spendCap = patch.spendCap as number;
    if (Number.isFinite(patch.maxStepsPerTask)) next.maxStepsPerTask = patch.maxStepsPerTask as number;
    if (Number.isFinite(patch.maxTokensPerTask)) next.maxTokensPerTask = patch.maxTokensPerTask as number;
    if (Number.isFinite(patch.softPct) && (patch.softPct as number) > 0 && (patch.softPct as number) < 100) this.softPct = patch.softPct as number;
    this.limits = next;
  }

  /** Текущие лимиты (read-only снимок). */
  getLimits(): SpendLimits {
    return { ...this.limits };
  }

  /**
   * Подписка на пересечение порогов (soft = softPct, hard = 100% потолка). Срабатывает ОДИН раз на
   * пересечение в пределах процесса (durable-«уже предупреждали» держит вызывающий — usage_quota.warned_*).
   */
  onThreshold(cb: (kind: ThresholdKind, pct: number) => void): () => void {
    this.thresholdCbs.push(cb);
    return () => {
      this.thresholdCbs = this.thresholdCbs.filter((c) => c !== cb);
    };
  }

  /** Доля потолка, израсходованная за период (0..∞, %). */
  get spentPct(): number {
    return this.limits.spendCap > 0 ? (this.spent / this.limits.spendCap) * 100 : 0;
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
    const before = this.spentPct;
    this.spent += c;
    const after = this.spentPct;
    // Персистентность usage_quota — best-effort (§14); промис ловим в drain().
    this.lastPersist = this.persistUsage(t, c);
    void this.lastPersist;
    // Пороги квоты (продуктовые предупреждения): пересечение softPct/100% — ровно на той записи, где случилось.
    if (this.thresholdCbs.length > 0 && c > 0) {
      if (before < this.softPct && after >= this.softPct) this.fireThreshold("soft", after);
      if (before < 100 && after >= 100) this.fireThreshold("hard", after);
    }
  }

  private fireThreshold(kind: ThresholdKind, pct: number): void {
    for (const cb of this.thresholdCbs) {
      try {
        cb(kind, pct);
      } catch (e) {
        log.warn("SpendGuard.onThreshold: коллбэк упал", e instanceof Error ? e.message : String(e));
      }
    }
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
  async hydrate(userId: string, opts?: { source?: "estimate" | "ledger" }): Promise<void> {
    await this.forUser(userId).hydrate(opts);
  }

  /** Продуктовый режим: лимиты пользователя из плана (QuotaResolver). При мастер-флаге 0 не зовётся. */
  setLimitsFor(userId: string, patch: Partial<SpendLimits> & { softPct?: number }): void {
    this.forUser(userId).setLimits(patch);
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

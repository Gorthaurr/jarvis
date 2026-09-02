/**
 * QuotaResolver (план §5.3): лимиты SpendGuard пользователя ИЗ ПЛАНА, а не из платформенного дефолта.
 * Потолок периода = квота плана + неистёкшие кредиты (+ разрешённый овердрафт) в USD; BYO-ключ — только
 * runaway-кап (`defaultCapUsd`, деньги идут провайдеру пользователя); без живой подписки и без
 * `defaultPlanId` — 0: expired/canceled = деградация (tier0 + свой ключ), не «связь прервалась».
 *
 * `applyTo` — единственная точка, где лимиты доходят до SpendGuard (`setLimitsFor`); зовётся в handshake
 * до первого check(). Заодно пишет в usage_quota, ПО КАКОМУ плану считался потолок (quota_source) —
 * отчёт «Квоты» и споры читают это, а не гадают.
 */
import type { SpendGuards } from "../billing/index.js";
import { ensureUser } from "../db/users.js";
import { consumeCredits, creditBalanceMicro } from "./credits.js";
import { iso, q } from "./db.js";
import { periodOf } from "./ledger.js";
import { type Plan, getPlan } from "./plans.js";
import { type SpendSnapshot, type WarnKind, type WarnedState, buildUsageInfo, markWarned, readWarnedState, rubPerUsdFromEnv } from "./quota-usage-info.js";
import { effectivePlanFor } from "./subscriptions.js";
import type { UsageInfo } from "@jarvis/protocol";

export type QuotaStatus = "trialing" | "active" | "past_due" | "none";
export type QuotaSource = "plan" | "default" | "none";

export interface QuotaLimits {
  planId: string | null;
  planName: string | null;
  status: QuotaStatus;
  quotaMicro: number;
  /** Остаток кредитов пакетов (неистёкшие гранты). */
  creditsMicro: number;
  /** Уже списано с кредитов В ЭТОМ периоде — входит в кап, потому что уже входит в spent. */
  creditsConsumedMicro: number;
  /** Овердрафт плана. Всегда 0, пока перерасход не выставляется счётом — в кап не входит (ревью 2026-09-02). */
  overageMicro: number;
  capUsd: number;
  softPct: number;
  /** null = любая модель каталога ([] плана → null). */
  modelsAllowed: string[] | null;
  byoKey: boolean;
  periodEnd: string | null;
  quotaSource: QuotaSource;
  /** Честная пометка для UI/логов (BYO без прокси, past_due). */
  note?: string;
}

export interface QuotaResolverOptions {
  /** План для пользователя без подписки (напр. demo на стенде); нет → потолок 0. */
  defaultPlanId?: string;
  /** Runaway-кап для BYO-ключа (деньги не наши, но цикл агента ограничить надо). */
  defaultCapUsd: number;
  /** LLM-прокси проекта включён → BYO-план работает на ключе пользователя. Пока нет — BYO = кап 0. */
  byoSupported?: boolean;
  now?: () => number;
  rubPerUsd?: number;
}

interface QuotaRow {
  cost_micro: unknown;
  llm_quota_micro: unknown;
  credits_consumed_micro: unknown;
  cap_micro: unknown;
}

const toInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

export class QuotaResolver {
  private readonly now: () => number;
  /** Сериализация списаний per-user: два параллельных раунда не списывают один перерасход дважды. */
  private readonly settling = new Map<string, Promise<{ consumed: number; shortfall: number }>>();

  constructor(private readonly opts: QuotaResolverOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  async limitsFor(userId: string): Promise<QuotaLimits> {
    const now = this.now();
    const period = periodOf(now);
    const eff = await effectivePlanFor(userId, now);
    let plan: Plan | null = eff?.plan ?? null;
    let source: QuotaSource = eff ? "plan" : "none";
    if (!plan && this.opts.defaultPlanId) {
      plan = await getPlan(this.opts.defaultPlanId);
      source = plan ? "default" : "none";
    }
    const creditsMicro = Math.max(0, await creditBalanceMicro(userId, now));
    const creditsConsumedMicro = await this.consumedThisPeriod(userId, period);
    const { softPct } = await readWarnedState(userId, period);
    // effectivePlanFor отдаёт только ЖИВУЮ подписку (trialing|active|past_due) — expired/canceled сюда не доходят.
    const status: QuotaStatus = eff ? (eff.status as QuotaStatus) : "none";
    const periodEnd = eff ? iso(eff.subscription.currentPeriodEnd) : null;
    // Кредиты пакета — отдельная покупка (гибридная модель): работают и без подписки. Кап периода =
    // квота + остаток + уже списанное в периоде (списанное уже сидит в spent, иначе кап «съезжал» бы вниз).
    const creditsCapMicro = creditsMicro + creditsConsumedMicro;
    const base = { creditsMicro, creditsConsumedMicro, overageMicro: 0, softPct, periodEnd };
    if (!plan) {
      return { ...base, planId: null, planName: null, status, quotaMicro: 0, capUsd: creditsCapMicro / 1e6, modelsAllowed: null, byoKey: false, quotaSource: "none" };
    }
    const modelsAllowed = plan.modelsAllowed.length > 0 ? [...plan.modelsAllowed] : null;
    if (plan.byoKey) {
      // BYO без LLM-прокси проекта = запросы шли бы на КЛЮЧ ПРОЕКТА за план, не покрывающий COGS (ревью
      // 2026-09-02) → квоты плана нет, работают только кредиты пакетов; с прокси — runaway-кап (деньги идут
      // провайдеру пользователя).
      const supported = this.opts.byoSupported === true;
      return {
        ...base, planId: plan.id, planName: plan.name, status, quotaMicro: 0, modelsAllowed, byoKey: true, quotaSource: source,
        capUsd: supported ? this.opts.defaultCapUsd : creditsCapMicro / 1e6,
        ...(supported ? {} : { note: "план «свой ключ» пока не поддерживается сервером: запросы на ключ проекта не идут, работают только кредиты пакетов" }),
      };
    }
    // past_due = период оплаты прошёл, ждём платёж: квота плана ЗАМОРОЖЕНА (иначе grace 7 дн = ещё неделя
    // бесплатной квоты), кредиты пакетов остаются доступны.
    const quotaMicro = status === "past_due" ? 0 : plan.llmQuotaMicro;
    return {
      ...base, planId: plan.id, planName: plan.name, status, quotaMicro, modelsAllowed, byoKey: false, quotaSource: source,
      capUsd: (quotaMicro + creditsCapMicro) / 1e6,
      ...(status === "past_due" ? { note: "оплата периода не получена — квота плана приостановлена до платежа" } : {}),
    };
  }

  /** Применить лимиты плана к SpendGuard пользователя и зафиксировать источник квоты и полный кап в usage_quota. */
  async applyTo(spend: SpendGuards, userId: string): Promise<QuotaLimits> {
    const limits = await this.limitsFor(userId);
    spend.setLimitsFor(userId, { spendCap: limits.capUsd, softPct: limits.softPct });
    await ensureUser(userId); // usage_quota держит FK на users; порядок вызовов в handshake нас не спасает
    await q(
      `insert into usage_quota (user_id, period, llm_quota_micro, overage_allowed, overage_max_micro, quota_source, cap_micro)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (user_id, period) do update set
         llm_quota_micro = excluded.llm_quota_micro, overage_allowed = excluded.overage_allowed,
         overage_max_micro = excluded.overage_max_micro, quota_source = excluded.quota_source,
         cap_micro = excluded.cap_micro, updated_at = now()`,
      [
        userId, periodOf(this.now()), limits.quotaSource === "none" ? null : limits.quotaMicro, limits.overageMicro > 0, limits.overageMicro,
        limits.quotaSource === "none" ? null : limits.quotaSource, Math.round(limits.capUsd * 1e6),
      ],
    );
    // Кап вырос (пакет/новый план) — пороги, которые больше не пересечены, снимаются: иначе usage.info вечно
    // показывал бы «100», а новые пересечения молчали за durable-отметкой «уже предупреждали».
    await q(
      `update usage_quota set
         warned_100_at = case when cost_micro < $3::bigint then null else warned_100_at end,
         warned_80_at = case when cost_micro * 100 < $3::bigint * $4::int then null else warned_80_at end
       where user_id = $1 and period = $2`,
      [userId, periodOf(this.now()), Math.round(limits.capUsd * 1e6), Math.round(limits.softPct)],
    );
    return limits;
  }

  /** Откат отметки порога: реплика была принята, но не прозвучала (TTL/«стоп»/смерть сессии) — предупредим снова. */
  async unmarkWarned(userId: string, period: string, kind: WarnKind): Promise<void> {
    await q(`update usage_quota set ${kind === "80" ? "warned_80_at" : "warned_100_at"} = null, updated_at = now() where user_id = $1 and period = $2`, [userId, period]);
  }

  /**
   * Списать с кредитов перерасход сверх квоты плана в текущем периоде. Идемпотентно: сколько уже списано —
   * usage_quota.credits_consumed_micro; зовётся после каждой записи ledger. Гранты уменьшаются FIFO
   * (consumeCredits); нехватка — shortfall (кап SpendGuard остановит следующий раунд).
   */
  settleCredits(userId: string): Promise<{ consumed: number; shortfall: number }> {
    const prev = this.settling.get(userId) ?? Promise.resolve({ consumed: 0, shortfall: 0 });
    const run = prev.catch(() => undefined).then(() => this.settleOnce(userId));
    this.settling.set(userId, run);
    void run.catch(() => undefined).then(() => {
      if (this.settling.get(userId) === run) this.settling.delete(userId);
    });
    return run;
  }

  private async settleOnce(userId: string): Promise<{ consumed: number; shortfall: number }> {
    const now = this.now();
    const period = periodOf(now);
    const rows = await q<QuotaRow>("select cost_micro, llm_quota_micro, credits_consumed_micro, cap_micro from usage_quota where user_id = $1 and period = $2", [userId, period]);
    const r = rows[0];
    if (!r) return { consumed: 0, shortfall: 0 };
    // Лимиты этого периода ещё не применены (строку создал ledger на смене месяца, cap_micro пуст): без квоты
    // плана списание сожгло бы кредиты за расход, который покрывает план (контроль-ревью 2026-09-02) — ждём applyTo.
    if (r.cap_micro === null || r.cap_micro === undefined) return { consumed: 0, shortfall: 0 };
    // BYO на LLM-прокси: деньги идут провайдеру пользователя — с кредитов пакетов не списываем.
    if (this.opts.byoSupported && (await this.limitsFor(userId)).byoKey) return { consumed: 0, shortfall: 0 };
    const due = Math.max(0, toInt(r.cost_micro) - toInt(r.llm_quota_micro)) - toInt(r.credits_consumed_micro);
    if (due <= 0) return { consumed: 0, shortfall: 0 };
    const res = await consumeCredits(userId, due, now);
    if (res.consumed > 0) {
      await q("update usage_quota set credits_consumed_micro = credits_consumed_micro + $3, updated_at = now() where user_id = $1 and period = $2", [userId, period, res.consumed]);
    }
    return res;
  }

  private async consumedThisPeriod(userId: string, period: string): Promise<number> {
    const rows = await q<{ credits_consumed_micro: unknown }>("select credits_consumed_micro from usage_quota where user_id = $1 and period = $2", [userId, period]);
    return toInt(rows[0]?.credits_consumed_micro);
  }

  markWarned(userId: string, period: string, kind: WarnKind, now: number): Promise<void> {
    return markWarned(userId, period, kind, now);
  }

  warnedState(userId: string, period: string): Promise<WarnedState> {
    return readWarnedState(userId, period);
  }

  /** UsageInfo для клиента: лимиты плана + снимок SpendGuard + durable-пороги; кредиты по курсу периода. */
  async usageInfoFor(userId: string, snapshot: SpendSnapshot, _now: number): Promise<UsageInfo> {
    const limits = await this.limitsFor(userId);
    const warned = await readWarnedState(userId, snapshot.period);
    return buildUsageInfo(limits, snapshot, warned, this.opts.rubPerUsd ?? rubPerUsdFromEnv());
  }
}

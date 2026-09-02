/**
 * Подписки продукта (docs/PRODUCT_FRAMEWORK_PLAN §5.2): одна живая на пользователя (partial UNIQUE в 0102),
 * триал — один раз (users.trial_used_at), жизненный цикл trialing/active → past_due (grace) → expired.
 *
 * ЧЕСТНОСТЬ ДЕНЕГ: платный план без триала и без оплаты (source='signup') НЕ стартует — иначе регистрация
 * давала бы квоту мозга проекта бесплатно, а вебхук потом «продлевал» то, что никто не покупал. Бесплатные
 * планы (demo/trial) и решения админа (source='admin'/'demo') стартуют без оплаты. `expired` — деградация, не
 * отключение (квота проекта 0, узел живёт на tier0/BYO) — это решает QuotaResolver, здесь только статусы.
 *
 * Все переходы sweep'а — с ожидаемым статусом (оптимистическая блокировка): параллельный вебхук оплаты
 * побеждает, sweep свой переход просто не применяет.
 */
import { ensureUser } from "../db/users.js";
import { query } from "../db/pool.js";
import { DAY_MS, ProductError, iso, one, q } from "./db.js";
import { type Plan, getPlan } from "./plans.js";
import {
  type Subscription, type SubscriptionPatch, type SubscriptionSource, type SubscriptionStatus,
  fetchLiveSubscription, fetchLiveSubscriptions, fetchSubscription, insertSubscriptionSql, rowToSubscription, updateSubscription,
} from "./subscription-rows.js";

export type { Subscription, SubscriptionPatch, SubscriptionSource, SubscriptionStatus } from "./subscription-rows.js";

export type StartFailReason = "plan_not_found" | "plan_inactive" | "not_subscription" | "trial_used" | "already_live" | "payment_required";
export type StartResult =
  | { ok: true; subscription: Subscription; trial: boolean }
  | { ok: false; reason: StartFailReason; subscription?: Subscription };

export interface StartSubscriptionInput {
  userId: string;
  planId: string;
  source: SubscriptionSource;
  provider?: string;
  now: number;
  periodDays?: number;
  /** Инвойс, по которому выдана подписка (payment) — для идемпотентности повторного вебхука. */
  invoiceId?: string;
}

export async function getLiveSubscription(userId: string): Promise<Subscription | null> {
  return fetchLiveSubscription(userId);
}

export async function startSubscription(input: StartSubscriptionInput): Promise<StartResult> {
  const { userId, planId, source, now } = input;
  const periodDays = input.periodDays ?? 30;
  const plan = await getPlan(planId);
  if (!plan) return { ok: false, reason: "plan_not_found" };
  if (!plan.active) return { ok: false, reason: "plan_inactive" };
  if (plan.kind !== "subscription") return { ok: false, reason: "not_subscription" };
  const live = await fetchLiveSubscription(userId);
  if (live) return { ok: false, reason: "already_live", subscription: live };
  const wantsTrial = plan.trialDays > 0 && source !== "payment";
  if (!wantsTrial && plan.priceMinor > 0 && source === "signup") return { ok: false, reason: "payment_required" };
  await ensureUser(userId);
  if (wantsTrial) {
    // Атомарная заявка на триал: строка обновляется только если trial_used_at ещё пуст И адрес не заявлял триал
    // раньше (trial_claims без FK переживает purge удалённого аккаунта — контроль-ревью 2026-09-02).
    const claimed = await q<{ id: string }>(
      `update users set trial_used_at = $2 where id = $1 and trial_used_at is null
         and not exists (select 1 from trial_claims tc where tc.email_hash = users.email_hash) returning id`,
      [userId, iso(now)],
    );
    if (claimed.length === 0) return { ok: false, reason: "trial_used" };
    await q(
      "insert into trial_claims (email_hash, claimed_at) select email_hash, $2::timestamptz from users where id = $1 and email_hash is not null on conflict (email_hash) do nothing",
      [userId, iso(now)],
    );
  }
  const end = now + (wantsTrial ? plan.trialDays : periodDays) * DAY_MS;
  const sql = insertSubscriptionSql({
    userId, planId, status: wantsTrial ? "trialing" : "active", currentPeriodStart: now, currentPeriodEnd: end,
    trialEnd: wantsTrial ? end : null, provider: input.provider ?? "none", source, lastInvoiceId: input.invoiceId ?? null,
  });
  const res = await query<Record<string, unknown>>(sql.text, sql.params);
  if (res === null) {
    // Либо БД легла, либо partial UNIQUE отбил вторую живую (гонка двух стартов) — различаем перечитыванием.
    const raced = await fetchLiveSubscription(userId);
    if (raced) return { ok: false, reason: "already_live", subscription: raced };
    throw new ProductError("db_unavailable", "подписка не создана: БД недоступна или отвергла запись");
  }
  return { ok: true, subscription: rowToSubscription(one(res.rows, "subscriptions insert")), trial: wantsTrial };
}

/**
 * Продление после оплаты: период отсчитывается от конца текущего (ранняя оплата не теряет дни), а если он
 * уже прошёл или подписка была пробной — от момента оплаты. Grace снимается, отмена «в конце периода» —
 * тоже (пользователь заплатил, значит остаётся).
 */
export async function renewSubscription(subId: string, now: number, periodDays = 30, opts?: { invoiceId?: string; provider?: string }): Promise<Subscription | null> {
  const s = await fetchSubscription(subId);
  if (!s) return null;
  const start = s.status === "active" && s.currentPeriodEnd > now ? s.currentPeriodEnd : now;
  return updateSubscription(subId, {
    status: "active", currentPeriodStart: start, currentPeriodEnd: start + periodDays * DAY_MS,
    graceUntil: null, cancelAtPeriodEnd: false,
    // Оплаченное продление: подписка, выданная админом/триалом, становится платной (MRR считает source=payment).
    ...(opts?.invoiceId ? { lastInvoiceId: opts.invoiceId, source: "payment" as const } : {}),
    ...(opts?.provider ? { provider: opts.provider } : {}),
  });
}

export async function cancelAtPeriodEnd(subId: string): Promise<Subscription | null> {
  return updateSubscription(subId, { cancelAtPeriodEnd: true });
}

export async function transition(subId: string, status: SubscriptionStatus, patch: SubscriptionPatch = {}): Promise<Subscription | null> {
  return updateSubscription(subId, { ...patch, status });
}

export interface LifecycleTransition {
  subscriptionId: string;
  userId: string;
  planId: string;
  from: SubscriptionStatus;
  to: SubscriptionStatus;
}

/** Целевой переход одной живой подписки на момент `now`; null — переходить рано. */
export function lifecycleTarget(s: Subscription, now: number, graceDays: number): { to: SubscriptionStatus; patch: SubscriptionPatch } | null {
  const grace = { graceUntil: now + graceDays * DAY_MS };
  // Триал → сразу expired: past_due (grace 7 дн с ПОЛНОЙ квотой) означал бы ещё неделю бесплатной работы
  // сверх обещанного триала (ревью 2026-09-02). Grace — для тех, кто уже платил.
  if (s.status === "trialing" && s.trialEnd !== null && s.trialEnd < now) return { to: "expired", patch: {} };
  if (s.status === "past_due" && s.graceUntil !== null && s.graceUntil < now) return { to: "expired", patch: {} };
  if (s.status === "active" && s.currentPeriodEnd < now) {
    return s.cancelAtPeriodEnd ? { to: "canceled", patch: {} } : { to: "past_due", patch: grace };
  }
  return null;
}

/** Регулярный проход по живым подпискам; каждая переводится не больше чем на один шаг за проход. */
export async function sweepLifecycle(now: number, graceDays = 7): Promise<LifecycleTransition[]> {
  const out: LifecycleTransition[] = [];
  for (const s of await fetchLiveSubscriptions()) {
    const target = lifecycleTarget(s, now, graceDays);
    if (!target) continue;
    const updated = await updateSubscription(s.id, { ...target.patch, status: target.to }, s.status, s.currentPeriodEnd);
    if (updated) out.push({ subscriptionId: s.id, userId: s.userId, planId: s.planId, from: s.status, to: target.to });
  }
  return out;
}

export interface EffectivePlan {
  plan: Plan;
  subscription: Subscription;
  status: SubscriptionStatus;
}

/** План, по которому пользователь живёт сейчас (живая подписка + её план); нет живой → null. */
export async function effectivePlanFor(userId: string, _now: number): Promise<EffectivePlan | null> {
  const sub = await fetchLiveSubscription(userId);
  if (!sub) return null;
  const plan = await getPlan(sub.planId);
  if (!plan) return null;
  return { plan, subscription: sub, status: sub.status };
}

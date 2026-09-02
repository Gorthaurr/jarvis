/**
 * Строки таблицы `subscriptions` (миграция 0102): тип, маппинг и примитивы чтения/записи.
 * Бизнес-правила (триал, продление, жизненный цикл) — в subscriptions.ts; здесь только «как лежит в БД».
 *
 * Правки статуса идут с ОЖИДАЕМЫМ текущим статусом (`expectStatus`): sweep жизненного цикла и вебхук оплаты
 * могут прийти одновременно, и «past_due → expired» не должно перетереть «past_due → active» от только что
 * пришедшего платежа. Проигравший обновление получает null и перечитывает.
 */
import { iso, ms, q } from "./db.js";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "expired";
export const LIVE_STATUSES: readonly SubscriptionStatus[] = ["trialing", "active", "past_due"];
export type SubscriptionSource = "signup" | "payment" | "admin" | "demo";

export interface Subscription {
  id: string;
  userId: string;
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  trialEnd: number | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: number | null;
  provider: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  source: SubscriptionSource;
  createdAt: number;
  updatedAt: number;
}

export interface SubscriptionPatch {
  status?: SubscriptionStatus;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  trialEnd?: number | null;
  cancelAtPeriodEnd?: boolean;
  graceUntil?: number | null;
  provider?: string;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  /** Оплаченное продление подписки, выданной админом/триалом: источник становится payment (MRR это видит). */
  source?: SubscriptionSource;
  /** Инвойс, последним создавший/продливший подписку — идемпотентность повторного вебхука. */
  lastInvoiceId?: string | null;
}

const COLS =
  "id, user_id, plan_id, status, current_period_start, current_period_end, trial_end, cancel_at_period_end, " +
  "grace_until, provider, provider_customer_id, provider_subscription_id, source, created_at, updated_at";

const PATCH_COLUMNS: Record<keyof SubscriptionPatch, string> = {
  status: "status",
  currentPeriodStart: "current_period_start",
  currentPeriodEnd: "current_period_end",
  trialEnd: "trial_end",
  cancelAtPeriodEnd: "cancel_at_period_end",
  graceUntil: "grace_until",
  provider: "provider",
  providerCustomerId: "provider_customer_id",
  providerSubscriptionId: "provider_subscription_id",
  source: "source",
  lastInvoiceId: "last_invoice_id",
};

type Row = Record<string, unknown>;

export function rowToSubscription(r: Row): Subscription {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    planId: String(r.plan_id),
    status: String(r.status) as SubscriptionStatus,
    currentPeriodStart: ms(r.current_period_start) ?? 0,
    currentPeriodEnd: ms(r.current_period_end) ?? 0,
    trialEnd: ms(r.trial_end),
    cancelAtPeriodEnd: r.cancel_at_period_end === true,
    graceUntil: ms(r.grace_until),
    provider: String(r.provider ?? "none"),
    providerCustomerId: r.provider_customer_id == null ? null : String(r.provider_customer_id),
    providerSubscriptionId: r.provider_subscription_id == null ? null : String(r.provider_subscription_id),
    source: String(r.source ?? "signup") as SubscriptionSource,
    createdAt: ms(r.created_at) ?? 0,
    updatedAt: ms(r.updated_at) ?? 0,
  };
}

/** Значение патча → параметр запроса (время — ISO, null — NULL). */
function toParam(v: unknown): unknown {
  return typeof v === "number" ? iso(v) : v;
}

export async function fetchSubscription(id: string): Promise<Subscription | null> {
  const rows = await q<Row>(`select ${COLS} from subscriptions where id = $1`, [id]);
  return rows[0] ? rowToSubscription(rows[0]) : null;
}

/** Живая подписка пользователя (partial UNIQUE гарантирует не больше одной). */
export async function fetchLiveSubscription(userId: string): Promise<Subscription | null> {
  const rows = await q<Row>(
    `select ${COLS} from subscriptions where user_id = $1 and status in ('trialing','active','past_due') limit 1`,
    [userId],
  );
  return rows[0] ? rowToSubscription(rows[0]) : null;
}

export async function fetchLiveSubscriptions(): Promise<Subscription[]> {
  const rows = await q<Row>(`select ${COLS} from subscriptions where status in ('trialing','active','past_due') order by created_at`);
  return rows.map(rowToSubscription);
}

/**
 * Обновить поля; `expectStatus` — оптимистическая блокировка по текущему статусу.
 * null = строки нет ИЛИ статус уже другой (кто-то успел раньше) — вызывающий перечитывает.
 */
export async function updateSubscription(id: string, patch: SubscriptionPatch, expectStatus?: SubscriptionStatus, expectPeriodEnd?: number): Promise<Subscription | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id];
  for (const [key, col] of Object.entries(PATCH_COLUMNS) as Array<[keyof SubscriptionPatch, string]>) {
    if (!(key in patch)) continue;
    params.push(toParam(patch[key]));
    sets.push(`${col} = $${params.length}`);
  }
  let where = "id = $1";
  if (expectStatus) {
    params.push(expectStatus);
    where += ` and status = $${params.length}`;
  }
  // Оптимистическая блокировка и по концу периода: sweep, прочитавший подписку ДО оплаты, не должен переводить в
  // past_due только что продлённую (renew оставляет status=active, одного статуса мало — контроль-ревью).
  if (expectPeriodEnd !== undefined) {
    params.push(iso(expectPeriodEnd));
    where += ` and current_period_end = $${params.length}`;
  }
  const rows = await q<Row>(`update subscriptions set ${sets.join(", ")} where ${where} returning ${COLS}`, params);
  return rows[0] ? rowToSubscription(rows[0]) : null;
}

export interface NewSubscription {
  userId: string;
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  trialEnd: number | null;
  provider: string;
  lastInvoiceId?: string | null;
  source: SubscriptionSource;
}

/** INSERT через сырой query: конфликт partial UNIQUE (вторая живая) — штатный исход, не db_unavailable. */
export function insertSubscriptionSql(s: NewSubscription): { text: string; params: unknown[] } {
  return {
    text: `insert into subscriptions (user_id, plan_id, status, current_period_start, current_period_end, trial_end, provider, source, last_invoice_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${COLS}`,
    params: [s.userId, s.planId, s.status, iso(s.currentPeriodStart), iso(s.currentPeriodEnd), s.trialEnd === null ? null : iso(s.trialEnd), s.provider, s.source, s.lastInvoiceId ?? null],
  };
}

/**
 * Обработка вебхуков оплаты — ОДНО место, где деньги превращаются в подписку/кредиты.
 *
 * Идемпотентность: (provider, event_id) — PK webhook_events; INSERT ON CONFLICT DO NOTHING. Дубль → no-op без
 * побочек. Заявка, у которой обработка оборвалась исключением (БД легла посреди), остаётся с processed_at
 * NULL и через RECLAIM_AFTER_MS отдаётся повтору провайдера — иначе оплата «зависла бы» навсегда.
 *
 * ЧЕСТНОСТЬ: «оплачено» ставится ТОЛЬКО если (1) провайдер с API подтвердил статус paid и (2) сумма/валюта
 * события РАВНЫ инвойсу. Иначе outcome amount_mismatch/status_unconfirmed, инвойс остаётся pending, подписка
 * не выдаётся — это разбирает админ, а не «округляет» код. Частичный возврат подписку не снимает (partial_refund).
 * Пул не даёт транзакций (query — одиночные запросы): шаги идемпотентны по отдельности, порядок — деньги
 * сначала (payment+invoice), потом выдача; сбой выдачи после фиксации денег → outcome 'error' с текстом для админа.
 */
import { createLogger } from "@jarvis/shared";
import { ProductError, iso, q } from "../db.js";
import { grantCredits } from "../credits.js";
import { type Plan, getPlan } from "../plans.js";
import { getLiveSubscription, renewSubscription, startSubscription, transition } from "../subscriptions.js";
import { type Invoice, findInvoiceByRef, setInvoiceStatus } from "./invoices.js";
import { insertPayment } from "./payments.js";
import type { PaymentProvider, WebhookEvent } from "./provider.js";

const log = createLogger("product:webhooks");
const RECLAIM_AFTER_MS = 5 * 60_000;

export type WebhookOutcome =
  | "applied" | "duplicate" | "invoice_not_found" | "amount_mismatch" | "status_unconfirmed"
  | "already_paid" | "partial_refund" | "ignored" | "error" | "retry_later";

export interface WebhookResult {
  duplicate: boolean;
  outcome: WebhookOutcome;
  message: string;
  invoiceId?: string;
  subscriptionId?: string;
  grantId?: string;
}

type Claim = "claimed" | "duplicate" | "in_flight";

/**
 * Заявить событие. claimed — наше (первое, брошенное >5 мин назад или упавшее с исключением — его забираем СРАЗУ);
 * in_flight — ещё обрабатывается (повтор получит retry_later, не ложный duplicate); duplicate — уже обработано.
 */
async function claimEvent(provider: string, event: WebhookEvent, now: number): Promise<Claim> {
  const inserted = await q<{ event_id: string }>(
    "insert into webhook_events (provider, event_id, received_at, payload) values ($1,$2,$3,$4) on conflict (provider, event_id) do nothing returning event_id",
    [provider, event.eventId, iso(now), JSON.stringify(event.raw ?? {})],
  );
  if (inserted.length > 0) return "claimed";
  const reclaimed = await q<{ event_id: string }>(
    `update webhook_events set received_at = $3 where provider = $1 and event_id = $2 and processed_at is null
       and (received_at < $4 or coalesce(outcome, '') like 'error:%') returning event_id`,
    [provider, event.eventId, iso(now), iso(now - RECLAIM_AFTER_MS)],
  );
  if (reclaimed.length > 0) return "claimed";
  const rows = await q<{ processed_at: unknown }>("select processed_at from webhook_events where provider = $1 and event_id = $2", [provider, event.eventId]);
  return rows[0] && (rows[0].processed_at === null || rows[0].processed_at === undefined) ? "in_flight" : "duplicate";
}

async function finishEvent(provider: string, eventId: string, outcome: string, now: number, processed: boolean): Promise<void> {
  await q("update webhook_events set outcome = $3, processed_at = $4 where provider = $1 and event_id = $2", [provider, eventId, outcome, processed ? iso(now) : null]);
}

export async function processWebhook(provider: PaymentProvider, event: WebhookEvent, now: number): Promise<WebhookResult> {
  const claim = await claimEvent(provider.kind, event, now);
  if (claim === "duplicate") return { duplicate: true, outcome: "duplicate", message: "событие уже обработано" };
  if (claim === "in_flight") return { duplicate: false, outcome: "retry_later", message: "событие ещё обрабатывается — повторите позже" };
  let result: WebhookResult;
  try {
    result = await apply(provider, event, now);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishEvent(provider.kind, event.eventId, `error: ${msg.slice(0, 200)}`, now, false).catch(() => {});
    throw e;
  }
  await finishEvent(provider.kind, event.eventId, result.outcome, now, true);
  if (result.outcome !== "applied") log.warn("вебхук не применён", { provider: provider.kind, eventId: event.eventId, outcome: result.outcome, message: result.message });
  return result;
}

async function apply(provider: PaymentProvider, event: WebhookEvent, now: number): Promise<WebhookResult> {
  const invoice = await findInvoiceByRef(provider.kind, event.providerRef);
  if (!invoice) return { duplicate: false, outcome: "invoice_not_found", message: `инвойс с provider_ref=${event.providerRef} не найден` };
  const base = { duplicate: false, invoiceId: invoice.id };
  if (event.kind === "paid") return applyPaid(provider, event, invoice, now);
  if (event.kind === "refunded") return applyRefund(provider, event, invoice, now);
  if (invoice.status !== "pending") return { ...base, outcome: "ignored", message: `инвойс уже ${invoice.status}` };
  await insertPayment(invoice.id, provider.kind, event, event.kind);
  await setInvoiceStatus(invoice.id, event.kind);
  return { ...base, outcome: "applied", message: `инвойс → ${event.kind}` };
}

interface Delivery {
  grantId?: string;
  subscriptionId?: string;
  message: string;
  /** true — выдача состоялась в ЭТОМ вызове, false — уже была (сверка по инвойсу). */
  delivered: boolean;
}

const grantNote = (invoice: Invoice): string => `invoice:${invoice.id}`;

async function applyPaid(provider: PaymentProvider, event: WebhookEvent, invoice: Invoice, now: number): Promise<WebhookResult> {
  const base = { duplicate: false, invoiceId: invoice.id };
  const plan = invoice.planId ? await getPlan(invoice.planId) : null;
  if (!plan) throw new ProductError("plan_not_found", `план инвойса ${invoice.id} не найден`);
  // Повтор события по УЖЕ оплаченному инвойсу: платёж не дублируем, но ВЫДАЧУ сверяем и довыдаём (ревью 2026-09-02:
  // раньше already_paid отвечался и тогда, когда выдача упала ПОСЛЕ пометки paid — пользователь платил за воздух).
  if (invoice.status === "paid") {
    const d = await deliver(provider, invoice, plan, now);
    if (d.delivered) log.warn("вебхук: инвойс был paid без выдачи — довыдано", { invoiceId: invoice.id, message: d.message });
    return { ...base, outcome: d.delivered ? "applied" : "already_paid", ...pick(d), message: d.delivered ? `инвойс был оплачен без выдачи — довыдано: ${d.message}` : d.message };
  }
  if (provider.fetchPaymentStatus) {
    const st = await provider.fetchPaymentStatus(event.providerRef);
    if (st !== "paid") return { ...base, outcome: "status_unconfirmed", message: `провайдер не подтвердил оплату (status=${st})` };
  }
  if (event.amountMinor !== invoice.amountMinor || event.currency.toUpperCase() !== invoice.currency.toUpperCase()) {
    return { ...base, outcome: "amount_mismatch", message: `сумма события ${event.amountMinor} ${event.currency} ≠ инвойса ${invoice.amountMinor} ${invoice.currency} — подписка НЕ выдана` };
  }
  // Порядок: СНАЧАЛА выдача (идемпотентная — сверка по инвойсу), ПОТОМ платёж и статус paid. Провал выдачи =
  // исключение = событие остаётся необработанным (processed_at NULL, outcome error → повтор забирает его сразу),
  // инвойс НЕ помечен оплаченным; повтор после сбоя между выдачей и платежом НЕ выдаёт второй раз.
  const d = await deliver(provider, invoice, plan, now);
  await insertPayment(invoice.id, provider.kind, event, "succeeded");
  await setInvoiceStatus(invoice.id, "paid", { paidAt: now, ...(d.subscriptionId ? { subscriptionId: d.subscriptionId } : {}) });
  return { ...base, outcome: "applied", ...pick(d), message: d.message };
}

const pick = (d: Delivery): { grantId?: string; subscriptionId?: string } => ({
  ...(d.grantId ? { grantId: d.grantId } : {}),
  ...(d.subscriptionId ? { subscriptionId: d.subscriptionId } : {}),
});

/** Уже выдано по этому инвойсу? Пакет — грант с пометкой инвойса; подписка — last_invoice_id (или subscription_id инвойса, legacy). */
async function priorDelivery(invoice: Invoice, plan: Plan): Promise<Delivery | null> {
  if (plan.kind === "pack") {
    const rows = await q<{ id: string }>("select id from credit_grants where user_id = $1 and note = $2 limit 1", [invoice.userId, grantNote(invoice)]);
    return rows[0] ? { grantId: rows[0].id, message: "инвойс уже оплачен, пакет выдан", delivered: false } : null;
  }
  const subs = await q<{ id: string }>("select id from subscriptions where user_id = $1 and last_invoice_id = $2 limit 1", [invoice.userId, invoice.id]);
  if (subs[0]) return { subscriptionId: subs[0].id, message: "инвойс уже оплачен, подписка выдана", delivered: false };
  if (invoice.subscriptionId) return { subscriptionId: invoice.subscriptionId, message: "инвойс уже оплачен, подписка выдана", delivered: false };
  return null;
}

async function deliver(provider: PaymentProvider, invoice: Invoice, plan: Plan, now: number): Promise<Delivery> {
  const prior = await priorDelivery(invoice, plan);
  if (prior) return prior;
  if (plan.kind === "pack") {
    const g = await grantCredits({ userId: invoice.userId, source: "pack", planId: plan.id, amountMicro: plan.packCreditsMicro, note: grantNote(invoice) });
    return { grantId: g.id, message: `пакет ${plan.id}: +${plan.packCreditsMicro} µ$`, delivered: true };
  }
  const live = await getLiveSubscription(invoice.userId);
  if (live && live.planId === plan.id) {
    const renewed = await renewSubscription(live.id, now, 30, { invoiceId: invoice.id, provider: provider.kind });
    if (!renewed) throw new ProductError("renew_failed", `подписка ${live.id} не продлилась — нужен админ`);
    return { subscriptionId: renewed.id, message: `подписка ${plan.id} продлена до ${iso(renewed.currentPeriodEnd)}`, delivered: true };
  }
  if (live) await transition(live.id, "canceled"); // смена плана: старая закрывается, новая — с оплаты
  const started = await startSubscription({ userId: invoice.userId, planId: plan.id, source: "payment", provider: provider.kind, now, invoiceId: invoice.id });
  if (!started.ok) throw new ProductError("subscription_failed", `подписка ${plan.id} не выдана (${started.reason}) — нужен админ`);
  return { subscriptionId: started.subscription.id, message: `подписка ${plan.id} выдана`, delivered: true };
}

async function applyRefund(provider: PaymentProvider, event: WebhookEvent, invoice: Invoice, now: number): Promise<WebhookResult> {
  const base = { duplicate: false, invoiceId: invoice.id };
  if (invoice.status !== "paid") return { ...base, outcome: "ignored", message: `возврат по неоплаченному инвойсу (${invoice.status})` };
  await insertPayment(invoice.id, provider.kind, event, "refunded");
  if (event.amountMinor < invoice.amountMinor) return { ...base, outcome: "partial_refund", message: `частичный возврат ${event.amountMinor} из ${invoice.amountMinor} — подписка/кредиты не отозваны` };
  await setInvoiceStatus(invoice.id, "refunded");
  const plan = invoice.planId ? await getPlan(invoice.planId) : null;
  if (plan?.kind === "pack") {
    const g = await grantCredits({ userId: invoice.userId, source: "refund", planId: plan.id, amountMicro: -plan.packCreditsMicro, note: `refund invoice:${invoice.id}` });
    return { ...base, outcome: "applied", grantId: g.id, message: `возврат пакета ${plan.id}: −${plan.packCreditsMicro} µ$` };
  }
  const live = await getLiveSubscription(invoice.userId);
  const target = live && (invoice.subscriptionId ? live.id === invoice.subscriptionId : live.planId === invoice.planId) ? live : null;
  if (!target) return { ...base, outcome: "applied", message: "возврат зафиксирован; живой подписки по этому инвойсу нет" };
  await transition(target.id, "canceled", { currentPeriodEnd: Math.min(target.currentPeriodEnd, now) });
  return { ...base, outcome: "applied", subscriptionId: target.id, message: `возврат: подписка ${target.planId} отменена` };
}

/**
 * Инвойсы (таблица `invoices`, миграция 0103): «за что и сколько» до оплаты, ссылка на hosted-checkout,
 * статус после вебхука. Сумма — из плана на момент выставления (провайдер получает её же); при обработке
 * оплаты сверяется именно с invoice.amount_minor, а не с текущей ценой плана (админ мог её поменять).
 *
 * Порядок createInvoice: строка pending → checkout у провайдера → provider_ref/checkout_url. Провайдер упал →
 * инвойс помечается canceled и ошибка уходит вызывающему (висящих «pending без ссылки» не оставляем).
 */
import { ensureUser } from "../../db/users.js";
import { ProductError, int, iso, ms, one, q } from "../db.js";
import { getPlan } from "../plans.js";
import type { PaymentProvider } from "./provider.js";

export type InvoiceStatus = "draft" | "pending" | "paid" | "failed" | "refunded" | "canceled";

export interface Invoice {
  id: string;
  userId: string;
  subscriptionId: string | null;
  planId: string | null;
  amountMinor: number;
  currency: string;
  status: InvoiceStatus;
  provider: string;
  providerRef: string | null;
  checkoutUrl: string | null;
  createdAt: number;
  paidAt: number | null;
}

const COLS = "id, user_id, subscription_id, plan_id, amount_minor, currency, status, provider, provider_ref, checkout_url, created_at, paid_at";
type Row = Record<string, unknown>;

function rowToInvoice(r: Row): Invoice {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    subscriptionId: r.subscription_id == null ? null : String(r.subscription_id),
    planId: r.plan_id == null ? null : String(r.plan_id),
    amountMinor: int(r.amount_minor),
    currency: String(r.currency ?? "RUB"),
    status: String(r.status) as InvoiceStatus,
    provider: String(r.provider ?? "none"),
    providerRef: r.provider_ref == null ? null : String(r.provider_ref),
    checkoutUrl: r.checkout_url == null ? null : String(r.checkout_url),
    createdAt: ms(r.created_at) ?? 0,
    paidAt: ms(r.paid_at),
  };
}

export interface CreateInvoiceInput {
  userId: string;
  planId: string;
  provider: PaymentProvider;
  now: number;
  returnUrl: string;
}

export async function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  const plan = await getPlan(input.planId);
  if (!plan) throw new ProductError("plan_not_found", `план ${input.planId} не найден`);
  if (!plan.active) throw new ProductError("invalid_input", `план ${plan.id} выключен — оплатить нельзя`);
  if (plan.priceMinor <= 0) throw new ProductError("invalid_input", `план ${plan.id} бесплатный — он выдаётся, а не оплачивается`);
  await ensureUser(input.userId);
  const rows = await q<Row>(
    `insert into invoices (user_id, plan_id, amount_minor, currency, status, provider, created_at)
     values ($1,$2,$3,$4,'pending',$5,$6) returning ${COLS}`,
    [input.userId, plan.id, plan.priceMinor, plan.currency, input.provider.kind, iso(input.now)],
  );
  const invoice = rowToInvoice(one(rows, "invoices insert"));
  let checkout: { url: string; providerRef: string };
  try {
    checkout = await input.provider.createCheckout({ userId: input.userId, invoiceId: invoice.id, plan, returnUrl: input.returnUrl });
  } catch (e) {
    await q("update invoices set status = 'canceled' where id = $1", [invoice.id]);
    throw e;
  }
  const updated = await q<Row>(`update invoices set provider_ref = $2, checkout_url = $3 where id = $1 returning ${COLS}`, [invoice.id, checkout.providerRef, checkout.url]);
  return rowToInvoice(one(updated, "invoices checkout"));
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  const rows = await q<Row>(`select ${COLS} from invoices where id = $1`, [id]);
  return rows[0] ? rowToInvoice(rows[0]) : null;
}

export async function findInvoiceByRef(provider: string, providerRef: string): Promise<Invoice | null> {
  const rows = await q<Row>(`select ${COLS} from invoices where provider = $1 and provider_ref = $2`, [provider, providerRef]);
  return rows[0] ? rowToInvoice(rows[0]) : null;
}

export async function listInvoices(userId: string, limit = 50): Promise<Invoice[]> {
  const rows = await q<Row>(`select ${COLS} from invoices where user_id = $1 order by created_at desc limit $2`, [userId, limit]);
  return rows.map(rowToInvoice);
}

export async function setInvoiceStatus(id: string, status: InvoiceStatus, extra: { paidAt?: number; subscriptionId?: string } = {}): Promise<Invoice | null> {
  const rows = await q<Row>(
    `update invoices set status = $2, paid_at = coalesce($3, paid_at), subscription_id = coalesce($4, subscription_id) where id = $1 returning ${COLS}`,
    [id, status, extra.paidAt === undefined ? null : iso(extra.paidAt), extra.subscriptionId ?? null],
  );
  return rows[0] ? rowToInvoice(rows[0]) : null;
}

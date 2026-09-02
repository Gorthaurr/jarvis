/**
 * Платежи (таблица `payments`, 0103) — факт движения денег у провайдера, привязанный к инвойсу. Один
 * provider_payment_id — одна строка (UNIQUE): повтор события не плодит платежей. `raw` — тело события для
 * разбора споров; реквизитов там нет (hosted-checkout, §0-p5).
 */
import { q } from "../db.js";
import type { WebhookEvent } from "./provider.js";

export type PaymentRowStatus = "succeeded" | "failed" | "refunded" | "canceled";

/** Вставить платёж; повтор по (provider, provider_payment_id) — no-op (false). */
export async function insertPayment(invoiceId: string, provider: string, event: WebhookEvent, status: PaymentRowStatus): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `insert into payments (invoice_id, provider, provider_payment_id, amount_minor, currency, status, raw)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (provider, provider_payment_id) do nothing returning id`,
    [invoiceId, provider, event.providerPaymentId, event.amountMinor, event.currency, status, JSON.stringify(event.raw ?? {})],
  );
  return rows.length > 0;
}

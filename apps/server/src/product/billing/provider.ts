/**
 * Контракт платёжного провайдера (docs/PRODUCT_FRAMEWORK_PLAN §5.2): только hosted-checkout — карт и
 * реквизитов в системе нет (§0-p5). Реализации: none (оплата выключена, планы даёт админ), fake (тесты и
 * /dev/product/webhook), yookassa (боевой, по публичной документации).
 *
 * ПРАВИЛО ЧЕСТНОСТИ ДЕНЕГ: сумма и статус в теле вебхука — данные из сети, а не факт оплаты. Провайдер,
 * у которого есть API, обязан перечитать платёж (`fetchPaymentStatus`), а webhooks.ts сверяет сумму события
 * с инвойсом и НЕ выдаёт подписку при расхождении.
 */
import type { BillingProviderKind } from "../policy.js";
import type { Plan } from "../plans.js";

export type WebhookKind = "paid" | "failed" | "refunded" | "canceled";

export interface WebhookEvent {
  /** Идемпотентный ключ события у провайдера (или производный `event:objectId`, если провайдер id не даёт). */
  eventId: string;
  kind: WebhookKind;
  /** Ссылка на чекаут/платёж, сохранённая в invoices.provider_ref при создании. */
  providerRef: string;
  /** Id платежа/возврата у провайдера (payments.provider_payment_id). */
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  raw: unknown;
}

export interface CheckoutRequest {
  userId: string;
  invoiceId: string;
  plan: Plan;
  returnUrl: string;
}

export interface CheckoutResult {
  url: string;
  providerRef: string;
}

export interface WebhookInput {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  ip?: string;
}

export type PaymentStatus = "paid" | "pending" | "failed" | "unknown";

export interface PaymentProvider {
  readonly kind: BillingProviderKind;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  /** null = подпись/источник/формат не подтверждены — событие НЕ обрабатывается. */
  verifyWebhook(input: WebhookInput): Promise<WebhookEvent | null>;
  /** Перечитать статус платежа у провайдера (источник истины вместо тела вебхука). */
  fetchPaymentStatus?(providerRef: string): Promise<PaymentStatus>;
}

/** Заголовок без учёта регистра (Fastify отдаёт lower-case, тесты — как написали). */
export function headerValue(headers: WebhookInput["headers"], name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want) continue;
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/**
 * Провайдер «оплата выключена» (JARVIS_BILLING_PROVIDER=none — дефолт продукта, пока демо для друзей):
 * checkout честно невозможен, планы выдаёт администратор (startSubscription source='admin'/'demo').
 * Вебхуков нет — любой входящий запрос не подтверждается (null), а не «принимается на всякий случай».
 */
import { ProductError } from "../../db.js";
import type { CheckoutRequest, CheckoutResult, PaymentProvider, WebhookEvent, WebhookInput } from "../provider.js";

export class NonePaymentProvider implements PaymentProvider {
  readonly kind = "none" as const;

  async createCheckout(_req: CheckoutRequest): Promise<CheckoutResult> {
    throw new ProductError("provider_none", "оплата выключена (JARVIS_BILLING_PROVIDER=none): план выдаёт администратор");
  }

  async verifyWebhook(_input: WebhookInput): Promise<WebhookEvent | null> {
    return null;
  }
}

/**
 * Тестовый провайдер оплаты (JARVIS_BILLING_PROVIDER=fake): чекауты в памяти процесса, ссылка на
 * loopback, вебхук — JSON с HMAC-SHA256 в заголовке `x-fake-signature`. Нужен тестам вебхуков и
 * `POST /dev/product/webhook` (владелец прогоняет путь «оплатил → подписка выдана» текст-драйвером).
 *
 * `makeEvent` — единственный способ изготовить валидное событие: подписывает ТОЧНО тот rawBody, который
 * уйдёт в verifyWebhook; сумма по умолчанию берётся из чекаута, но её можно переопределить — так тест
 * проверяет, что несовпадение суммы НЕ выдаёт подписку.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ProductError, requireNonNegativeInt } from "../../db.js";
import { type CheckoutRequest, type CheckoutResult, type PaymentProvider, type WebhookEvent, type WebhookInput, type WebhookKind, headerValue } from "../provider.js";

export interface FakeCheckout {
  providerRef: string;
  userId: string;
  invoiceId: string;
  planId: string;
  amountMinor: number;
  currency: string;
}

const KINDS: ReadonlySet<string> = new Set(["paid", "failed", "refunded", "canceled"]);

export class FakePaymentProvider implements PaymentProvider {
  readonly kind = "fake" as const;
  private readonly checkouts = new Map<string, FakeCheckout>();

  constructor(
    private readonly secret = "fake-webhook-secret",
    private readonly baseUrl = "http://127.0.0.1/fake-checkout/",
  ) {}

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const providerRef = `fake_${randomUUID()}`;
    this.checkouts.set(providerRef, {
      providerRef, userId: req.userId, invoiceId: req.invoiceId, planId: req.plan.id,
      amountMinor: req.plan.priceMinor, currency: req.plan.currency,
    });
    return { url: `${this.baseUrl}${providerRef}`, providerRef };
  }

  listCheckouts(): FakeCheckout[] {
    return [...this.checkouts.values()];
  }

  sign(rawBody: string): string {
    return createHmac("sha256", this.secret).update(rawBody, "utf8").digest("hex");
  }

  /** Изготовить подписанное событие (тесты, dev-эндпоинт). Сумма по умолчанию — из чекаута. */
  makeEvent(e: { providerRef: string; kind: WebhookKind; amountMinor?: number; currency?: string; eventId?: string; providerPaymentId?: string }): {
    headers: Record<string, string>;
    rawBody: string;
  } {
    const co = this.checkouts.get(e.providerRef);
    if (e.amountMinor === undefined && !co) {
      throw new ProductError("invalid_input", `fake: чекаут ${e.providerRef} неизвестен — укажите amountMinor явно`);
    }
    const body = {
      eventId: e.eventId ?? `evt_${randomUUID()}`,
      kind: e.kind,
      providerRef: e.providerRef,
      providerPaymentId: e.providerPaymentId ?? (e.kind === "refunded" ? `refund_${randomUUID()}` : `pay_${e.providerRef}`),
      amountMinor: e.amountMinor ?? co!.amountMinor,
      currency: e.currency ?? co?.currency ?? "RUB",
    };
    const rawBody = JSON.stringify(body);
    return { headers: { "x-fake-signature": this.sign(rawBody) }, rawBody };
  }

  async verifyWebhook(input: WebhookInput): Promise<WebhookEvent | null> {
    const given = headerValue(input.headers, "x-fake-signature");
    if (!given) return null;
    const expected = Buffer.from(this.sign(input.rawBody), "utf8");
    const got = Buffer.from(given, "utf8");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!body || typeof body !== "object") return null;
    const kind = String(body.kind);
    if (!KINDS.has(kind) || typeof body.eventId !== "string" || typeof body.providerRef !== "string" || typeof body.providerPaymentId !== "string") return null;
    let amountMinor: number;
    try {
      amountMinor = requireNonNegativeInt(body.amountMinor, "amountMinor");
    } catch {
      return null;
    }
    return {
      eventId: body.eventId, kind: kind as WebhookKind, providerRef: body.providerRef, providerPaymentId: body.providerPaymentId,
      amountMinor, currency: typeof body.currency === "string" ? body.currency : "RUB", raw: body,
    };
  }
}

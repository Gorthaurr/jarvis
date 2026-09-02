/**
 * ЮKassa (API v3, hosted-checkout) — боевой провайдер оплаты.
 *
 * ⚠️ ЖИВЬЁМ НЕ ПРОВЕРЕНО: контракт написан по публичной документации API v3 (POST /v3/payments с Basic
 * shopId:secretKey и Idempotence-Key; уведомления `{type:'notification', event, object}`; GET
 * /v3/payments/{id}, GET /v3/refunds/{id}). Первый прогон с тестовым магазином — за владельцем; при
 * расхождении формата provider_error виден в логе, подписка молча не выдаётся.
 *
 * ЧЕСТНОСТЬ ДЕНЕГ: ЮKassa вебхуки НЕ подписывает. Поэтому (1) опциональный allowlist IP источника
 * (по умолчанию — публичные диапазоны ЮKassa; за доверенным прокси задайте [] и проверяйте на прокси),
 * (2) ГЛАВНОЕ — сумма и статус берутся НЕ из тела уведомления, а перечитываются GET /payments/{id} (для
 * возврата — GET /refunds/{id}). Тело — лишь повод сходить в API. Не подтвердилось API → null (событие не
 * обрабатывается; провайдер повторит уведомление сам).
 *
 * `fetch` инжектируется в конструктор: тесты гоняют контракт запросов/ответов без сети.
 */
import { ProductError } from "../../db.js";
import type { CheckoutRequest, CheckoutResult, PaymentProvider, PaymentStatus, WebhookEvent, WebhookInput } from "../provider.js";
import { ipAllowed } from "./ip-allowlist.js";

/** Диапазоны источников уведомлений по документации ЮKassa (сверять при развёртывании). */
export const YOOKASSA_WEBHOOK_IPS: readonly string[] = [
  "185.71.76.0/27", "185.71.77.0/27", "77.75.153.0/25", "77.75.156.11", "77.75.156.35", "77.75.154.128/25", "2a02:5180::/32",
];

export interface YooKassaConfig {
  shopId: string;
  secretKey: string;
  /** По умолчанию https://api.yookassa.ru/v3 */
  apiBase?: string;
  /** undefined → YOOKASSA_WEBHOOK_IPS; [] → проверка источника ВЫКЛЮЧЕНА (только за доверенным прокси). */
  allowedIps?: readonly string[];
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** "150.00" → 15000 копеек; мусор → NaN (сравнение с инвойсом не сойдётся). */
export function amountToMinor(amount: unknown): number {
  const value = Number.parseFloat(str(obj(amount).value));
  return Number.isFinite(value) ? Math.round(value * 100) : Number.NaN;
}

export function mapPaymentStatus(status: string): PaymentStatus {
  if (status === "succeeded") return "paid";
  if (status === "pending" || status === "waiting_for_capture") return "pending";
  if (status === "canceled") return "failed";
  return "unknown";
}

export class YooKassaProvider implements PaymentProvider {
  readonly kind = "yookassa" as const;
  private readonly apiBase: string;
  private readonly auth: string;
  private readonly allowedIps: readonly string[];
  private readonly fetchFn: typeof fetch;

  constructor(cfg: YooKassaConfig) {
    if (!cfg.shopId?.trim() || !cfg.secretKey?.trim()) throw new ProductError("invalid_input", "ЮKassa: нужны shopId и secretKey");
    this.apiBase = (cfg.apiBase ?? "https://api.yookassa.ru/v3").replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${cfg.shopId.trim()}:${cfg.secretKey.trim()}`, "utf8").toString("base64")}`;
    this.allowedIps = cfg.allowedIps ?? YOOKASSA_WEBHOOK_IPS;
    this.fetchFn = cfg.fetch ?? fetch;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown, idempotenceKey?: string): Promise<Json> {
    const headers: Record<string, string> = { Authorization: this.auth, "Content-Type": "application/json" };
    if (idempotenceKey) headers["Idempotence-Key"] = idempotenceKey;
    const res = await this.fetchFn(`${this.apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new ProductError("provider_error", `ЮKassa ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    try {
      return obj(JSON.parse(text));
    } catch {
      throw new ProductError("provider_error", `ЮKassa ${method} ${path}: ответ не JSON`);
    }
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const body = {
      amount: { value: (req.plan.priceMinor / 100).toFixed(2), currency: req.plan.currency },
      capture: true,
      confirmation: { type: "redirect", return_url: req.returnUrl },
      description: `Jarvis: ${req.plan.name}`.slice(0, 128),
      metadata: { invoiceId: req.invoiceId, userId: req.userId, planId: req.plan.id },
    };
    const p = await this.call("POST", "/payments", body, req.invoiceId);
    const url = str(obj(p.confirmation).confirmation_url);
    const id = str(p.id);
    if (!url || !id) throw new ProductError("provider_error", "ЮKassa: в ответе нет id или confirmation_url");
    return { url, providerRef: id };
  }

  async fetchPayment(id: string): Promise<{ status: PaymentStatus; amountMinor: number; currency: string; raw: Json }> {
    const p = await this.call("GET", `/payments/${encodeURIComponent(id)}`);
    return { status: mapPaymentStatus(str(p.status)), amountMinor: amountToMinor(p.amount), currency: str(obj(p.amount).currency) || "RUB", raw: p };
  }

  async fetchPaymentStatus(providerRef: string): Promise<PaymentStatus> {
    return (await this.fetchPayment(providerRef)).status;
  }

  async verifyWebhook(input: WebhookInput): Promise<WebhookEvent | null> {
    if (this.allowedIps.length > 0 && !ipAllowed(input.ip, this.allowedIps)) return null;
    let body: Json;
    try {
      body = obj(JSON.parse(input.rawBody));
    } catch {
      return null;
    }
    const event = str(body.event);
    const object = obj(body.object);
    const id = str(object.id);
    if (body.type !== "notification" || !id) return null;
    const eventId = `${event}:${id}`;
    if (event === "payment.succeeded" || event === "payment.canceled") {
      const p = await this.fetchPayment(id); // источник истины — API, не тело
      const want: PaymentStatus = event === "payment.succeeded" ? "paid" : "failed";
      if (p.status !== want) return null;
      return { eventId, kind: want === "paid" ? "paid" : "canceled", providerRef: id, providerPaymentId: id, amountMinor: p.amountMinor, currency: p.currency, raw: body };
    }
    if (event === "refund.succeeded") {
      const r = await this.call("GET", `/refunds/${encodeURIComponent(id)}`);
      const paymentId = str(r.payment_id);
      if (str(r.status) !== "succeeded" || !paymentId) return null;
      return { eventId, kind: "refunded", providerRef: paymentId, providerPaymentId: id, amountMinor: amountToMinor(r.amount), currency: str(obj(r.amount).currency) || "RUB", raw: body };
    }
    return null; // waiting_for_capture и прочее — не наш сценарий (capture:true)
  }
}

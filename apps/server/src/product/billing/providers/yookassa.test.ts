/**
 * ЮKassa — контракт по документации с инжектированным fetch (сети нет): форма запроса чекаута, и главное —
 * вебхук НЕ верит телу: сумма/статус берутся из GET /payments/{id}; IP вне allowlist → null.
 */
import { describe, expect, it } from "vitest";
import type { Plan } from "../../plans.js";
import { ipAllowed, ipMatches, parseIp } from "./ip-allowlist.js";
import { YooKassaProvider, amountToMinor, mapPaymentStatus } from "./yookassa.js";

const plan: Plan = {
  id: "basic", name: "Базовый", kind: "subscription", priceMinor: 150000, currency: "RUB", period: "month",
  llmQuotaMicro: 8_000_000, packCreditsMicro: 0, overageAllowed: false, overageMaxMicro: 0, modelsAllowed: [], byoKey: false,
  trialDays: 0, features: {}, active: true, sortOrder: 40,
};

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(routes: Record<string, () => { status?: number; body: unknown }>, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const r = routes[key];
    if (!r) return new Response("not found", { status: 404 });
    const out = r();
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("billing/providers/yookassa (контракт, без сети)", () => {
  it("createCheckout: Basic auth, Idempotence-Key = invoiceId, тело по документации, ответ → url/ref", async () => {
    const calls: Call[] = [];
    const p = new YooKassaProvider({
      shopId: "123", secretKey: "sk", allowedIps: [],
      fetch: fakeFetch({ "POST /v3/payments": () => ({ body: { id: "pay_1", status: "pending", confirmation: { type: "redirect", confirmation_url: "https://yoomoney.ru/checkout/x" } } }) }, calls),
    });
    const co = await p.createCheckout({ userId: "u1", invoiceId: "inv-9", plan, returnUrl: "https://app/back" });
    expect(co).toEqual({ url: "https://yoomoney.ru/checkout/x", providerRef: "pay_1" });
    const call = calls[0]!;
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("123:sk").toString("base64")}`);
    expect(headers["Idempotence-Key"]).toBe("inv-9");
    expect(JSON.parse(String(call.init?.body))).toEqual({
      amount: { value: "1500.00", currency: "RUB" }, capture: true, confirmation: { type: "redirect", return_url: "https://app/back" },
      description: "Jarvis: Базовый", metadata: { invoiceId: "inv-9", userId: "u1", planId: "basic" },
    });
  });

  it("HTTP-ошибка провайдера → честный provider_error, не ссылка", async () => {
    const p = new YooKassaProvider({ shopId: "1", secretKey: "s", allowedIps: [], fetch: fakeFetch({ "POST /v3/payments": () => ({ status: 401, body: { code: "invalid_credentials" } }) }, []) });
    await expect(p.createCheckout({ userId: "u", invoiceId: "i", plan, returnUrl: "x" })).rejects.toThrow(/HTTP 401/);
  });

  it("verifyWebhook НЕ доверяет телу: сумма и статус — из GET /payments/{id}; API говорит pending → null", async () => {
    const calls: Call[] = [];
    let apiStatus = "succeeded";
    const p = new YooKassaProvider({
      shopId: "1", secretKey: "s", allowedIps: [],
      fetch: fakeFetch({ "GET /v3/payments/pay_7": () => ({ body: { id: "pay_7", status: apiStatus, amount: { value: "1500.00", currency: "RUB" } } }) }, calls),
    });
    const body = JSON.stringify({ type: "notification", event: "payment.succeeded", object: { id: "pay_7", status: "succeeded", amount: { value: "1.00", currency: "USD" } } });
    const ev = await p.verifyWebhook({ headers: {}, rawBody: body });
    expect(ev).toMatchObject({ kind: "paid", providerRef: "pay_7", providerPaymentId: "pay_7", amountMinor: 150000, currency: "RUB", eventId: "payment.succeeded:pay_7" });
    expect(calls.some((c) => c.url.endsWith("/v3/payments/pay_7"))).toBe(true);
    apiStatus = "pending";
    expect(await p.verifyWebhook({ headers: {}, rawBody: body })).toBeNull();
    expect(await p.verifyWebhook({ headers: {}, rawBody: "{}" })).toBeNull();
    expect(await p.verifyWebhook({ headers: {}, rawBody: "not json" })).toBeNull();
    expect(await p.fetchPaymentStatus("pay_7")).toBe("pending");
  });

  it("refund.succeeded → kind refunded с providerRef = payment_id из API возврата", async () => {
    const p = new YooKassaProvider({
      shopId: "1", secretKey: "s", allowedIps: [],
      fetch: fakeFetch({ "GET /v3/refunds/rf_1": () => ({ body: { id: "rf_1", payment_id: "pay_7", status: "succeeded", amount: { value: "1500.00", currency: "RUB" } } }) }, []),
    });
    const ev = await p.verifyWebhook({ headers: {}, rawBody: JSON.stringify({ type: "notification", event: "refund.succeeded", object: { id: "rf_1" } }) });
    expect(ev).toMatchObject({ kind: "refunded", providerRef: "pay_7", providerPaymentId: "rf_1", amountMinor: 150000 });
  });

  it("allowlist IP: дефолтные диапазоны ЮKassa пропускают свои адреса и режут чужие; [] выключает проверку", async () => {
    const fetchOk = fakeFetch({ "GET /v3/payments/p": () => ({ body: { id: "p", status: "succeeded", amount: { value: "10.00", currency: "RUB" } } }) }, []);
    const body = JSON.stringify({ type: "notification", event: "payment.succeeded", object: { id: "p" } });
    const strict = new YooKassaProvider({ shopId: "1", secretKey: "s", fetch: fetchOk });
    expect(await strict.verifyWebhook({ headers: {}, rawBody: body, ip: "185.71.76.5" })).not.toBeNull();
    expect(await strict.verifyWebhook({ headers: {}, rawBody: body, ip: "8.8.8.8" })).toBeNull();
    expect(await strict.verifyWebhook({ headers: {}, rawBody: body })).toBeNull();
    const open = new YooKassaProvider({ shopId: "1", secretKey: "s", allowedIps: [], fetch: fetchOk });
    expect(await open.verifyWebhook({ headers: {}, rawBody: body, ip: "8.8.8.8" })).not.toBeNull();
  });

  it("ip-allowlist: IPv4/IPv6 CIDR, mapped-адреса, мусор", () => {
    expect(ipMatches("185.71.76.31", "185.71.76.0/27")).toBe(true);
    expect(ipMatches("185.71.76.32", "185.71.76.0/27")).toBe(false);
    expect(ipMatches("77.75.156.11", "77.75.156.11")).toBe(true);
    expect(ipMatches("2a02:5180:abcd::1", "2a02:5180::/32")).toBe(true);
    expect(ipMatches("2a02:5181::1", "2a02:5180::/32")).toBe(false);
    expect(ipMatches("::ffff:185.71.76.3", "185.71.76.0/27")).toBe(true);
    expect(ipMatches("185.71.76.3", "2a02:5180::/32")).toBe(false);
    expect(parseIp("999.1.1.1")).toBeNull();
    expect(parseIp("1:::2")).toBeNull();
    expect(ipAllowed(undefined, ["0.0.0.0/0"])).toBe(false);
    expect(ipAllowed("1.2.3.4", ["0.0.0.0/0"])).toBe(true);
  });

  it("amountToMinor/mapPaymentStatus", () => {
    expect(amountToMinor({ value: "1500.00", currency: "RUB" })).toBe(150000);
    expect(amountToMinor({ value: "0.1" })).toBe(10);
    expect(Number.isNaN(amountToMinor({}))).toBe(true);
    expect(mapPaymentStatus("succeeded")).toBe("paid");
    expect(mapPaymentStatus("waiting_for_capture")).toBe("pending");
    expect(mapPaymentStatus("canceled")).toBe("failed");
    expect(mapPaymentStatus("???")).toBe("unknown");
  });
});

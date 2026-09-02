/**
 * /v1/webhooks/:provider — приём событий провайдера оплаты. Тело читается СЫРЫМ (подпись HMAC считается по
 * байтам), провайдер сверяет подпись/источник, затем processWebhook — идемпотентно по (provider, event_id).
 * Дубль → 200 без побочек; неверная подпись → 400 (провайдер не должен ретраить бесконечно по 5xx).
 */
import type { FastifyInstance } from "fastify";
import { createLogger } from "@jarvis/shared";
import { getInvoice } from "../billing/invoices.js";
import { processWebhook } from "../billing/webhooks.js";
import { type ProductRouteDeps, type RouteReply, type RouteRequest, params } from "./deps.js";
import { fail, isLoopbackIp } from "./guards.js";

const log = createLogger("product:webhooks");

export function registerWebhookRoutes(app: FastifyInstance, d: ProductRouteDeps): void {
  void app.register(async (instance) => {
    // Сырое тело ТОЛЬКО в этом инкапсулированном плагине: остальной сервер продолжает парсить JSON.
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser("*", { parseAs: "string" }, (_req, payload, done) => done(null, payload));
    instance.post("/v1/webhooks/:provider", async (req, reply) => {
      const r = reply as unknown as RouteReply;
      const provider = String(params(req as unknown as RouteRequest).provider ?? "");
      if (provider !== d.provider.kind) return fail(r, 404, "unknown_provider", "провайдер не настроен");
      // Фейковый провайдер — стенд владельца: события принимаются ТОЛЬКО с loopback (иначе любой, знающий
      // дефолтный секрет, выдавал бы себе подписки; ревью 2026-09-02).
      if (d.provider.kind === "fake" && !isLoopbackIp(req.ip)) return fail(r, 404, "unknown_provider", "провайдер не настроен");
      const rawBody = typeof req.body === "string" ? req.body : "";
      let event: Awaited<ReturnType<typeof d.provider.verifyWebhook>>;
      try {
        event = await d.provider.verifyWebhook({ headers: req.headers as Record<string, string | string[] | undefined>, rawBody, ip: req.ip });
      } catch (e) {
        // Сверка упала (API провайдера недоступен / 401 магазина) — в лог, наружу без внутренностей.
        log.error("вебхук: сверка события упала", { provider, error: e instanceof Error ? e.message : String(e) });
        return fail(r, 500, "internal", "событие не проверено — повторите позже");
      }
      if (!event) return fail(r, 400, "bad_signature", "подпись/источник события не подтверждены");
      try {
        const res = await processWebhook(d.provider, event, d.now());
        if (res.outcome === "retry_later") return fail(r, 503, "retry_later", res.message); // ещё в полёте — не ложный duplicate
        // Оплата применилась → лимиты плана/кредиты в SpendGuard сразу, без реконнекта пользователя.
        if (res.outcome === "applied" && res.invoiceId) {
          const inv = await getInvoice(res.invoiceId);
          if (inv) {
            await d.quota.applyTo(d.spend, inv.userId);
            // Человек только что заплатил: открытая вкладка и сам Джарвис обязаны увидеть новый баланс
            // СРАЗУ, а не после переподключения (живой прогон 2026-09-02: «заплатил — не заработало»).
            await d.pushUsage?.(inv.userId).catch(() => undefined);
          }
        }
        return r.code(200).send({ ok: true, data: { outcome: res.outcome, duplicate: res.duplicate, invoiceId: res.invoiceId } });
      } catch (e) {
        // Исключение = событие НЕ обработано (processed_at NULL, провайдер ретраит); детали — в лог, не наружу.
        log.error("вебхук: обработка упала", { provider, eventId: event.eventId, error: e instanceof Error ? e.message : String(e) });
        return fail(r, 500, "internal", "событие не обработано — повторите позже");
      }
    });
  });
}

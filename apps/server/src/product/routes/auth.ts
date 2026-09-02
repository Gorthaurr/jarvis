/**
 * /v1/auth/* — вход по одноразовому коду, выдача device/access/refresh-токенов, refresh, logout.
 * Ответ на запрос кода ОДИНАКОВ для существующего и несуществующего адреса (не раскрываем аккаунты).
 * Первый вход создаёт пользователя и, если разрешено политикой, стартует план регистрации (триал).
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createLogger } from "@jarvis/shared";
import { requestOtp, verifyOtp } from "../auth.js";
import { registerDevice } from "../devices.js";
import { DEVICE_TOKEN_TTL_MS } from "../identity.js";
import { startSubscription } from "../subscriptions.js";
import { revokeToken } from "../tokens-lifecycle.js";
import { inspectToken, issueToken, verifyToken } from "../tokens.js";
import { type ProductRouteDeps, type RouteReply, type RouteRequest, body, str } from "./deps.js";
import { authenticate, bearerOf, fail } from "./guards.js";

const log = createLogger("product:auth");

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function ipHashOf(ip: string | undefined): string | undefined {
  const v = String(ip ?? "").trim();
  return v ? createHash("sha256").update(v).digest("hex").slice(0, 32) : undefined;
}

/** Пара access+refresh для HTTP. null — БД не приняла (токенов НЕТ, честный 503). */
export async function issueSessionPair(userId: string, now: Date, ipHash?: string): Promise<{ accessToken: string; refreshToken: string; accessExpiresAt: string } | null> {
  const access = await issueToken({ userId, kind: "access", ttlMs: ACCESS_TTL_MS, now, ipHash });
  const refresh = await issueToken({ userId, kind: "refresh", ttlMs: REFRESH_TTL_MS, now, ipHash });
  if (!access || !refresh) return null;
  return { accessToken: access.raw, refreshToken: refresh.raw, accessExpiresAt: access.expiresAt.toISOString() };
}

export function registerAuthRoutes(app: FastifyInstance, d: ProductRouteDeps): void {
  app.post("/v1/auth/otp/request", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const b = body(req as unknown as RouteRequest);
    const purpose = str(b.purpose) === "delete" ? "delete" : "otp";
    const res = await requestOtp({
      email: str(b.email),
      pepper: d.pepper,
      limiter: d.limiter,
      sendMail: d.sendMail,
      purpose,
      ipHash: ipHashOf(req.ip),
      now: new Date(d.now()),
    });
    if (!res.accepted) {
      if (res.reason === "rate_limited") {
        return r.code(429).header("retry-after", String(Math.ceil(res.retryAfterMs / 1000))).send({ ok: false, error: { code: "rate_limited", message: "слишком много запросов кода — подождите" } });
      }
      if (res.reason === "invalid_email") return fail(r, 400, "invalid_email", "некорректный адрес");
      // Подробности (хост SMTP, текст ошибки БД) — в лог, не анонимному вызывающему (ревью 2026-09-02).
      log.warn("запрос кода входа не принят", { reason: res.reason, message: res.message });
      return fail(r, 503, res.reason, res.reason === "send_failed" ? "не удалось отправить код — попробуйте позже" : "сервис входа временно недоступен");
    }
    return r.code(202).send({ ok: true, data: { accepted: true, delivery: res.delivery, expiresAt: res.expiresAt.toISOString() } });
  });

  app.post("/v1/auth/otp/verify", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const b = body(req as unknown as RouteRequest);
    const now = new Date(d.now());
    const email = str(b.email);
    const v = await verifyOtp({ email, code: str(b.code), pepper: d.pepper, purpose: "otp", now, createIfMissing: true, encryptor: d.encryptor });
    if (!v.ok) {
      if (v.reason === "unavailable") return fail(r, 503, "unavailable", "БД недоступна — вход невозможен");
      if (v.reason === "blocked") return fail(r, 403, "blocked", "аккаунт заблокирован");
      return r.code(401).send({ ok: false, error: { code: "invalid_code", message: "код не подошёл", reason: v.reason, attemptsLeft: v.attemptsLeft } });
    }
    const ipHash = ipHashOf(req.ip);
    const pair = await issueSessionPair(v.userId, now, ipHash);
    if (!pair) return fail(r, 503, "unavailable", "не удалось выдать токены");
    let deviceToken: string | undefined;
    let deviceError: string | undefined;
    const installId = str(b.installId);
    if (installId) {
      const deviceId = await registerDevice({ userId: v.userId, installId, name: str(b.deviceName) || undefined, now });
      // Молчаливый 200 без device-токена = «вошёл, а подключить нечем» и никакой подсказки почему
      // (живой прогон 2026-09-02). Причина уходит рядом с токенами.
      if (!deviceId) deviceError = "installId должен быть UUID — device-токен не выдан";
      if (deviceId) {
        const dev = await issueToken({ userId: v.userId, kind: "device", ttlMs: DEVICE_TOKEN_TTL_MS, deviceId, label: str(b.deviceName) || "desktop", now, ipHash });
        deviceToken = dev?.raw;
      }
    }
    let signupPlan: string | undefined;
    if (v.created && d.signupPlanId && d.policy.billing) {
      const s = await startSubscription({ userId: v.userId, planId: d.signupPlanId, source: "signup", now: d.now() });
      if (s.ok) signupPlan = s.subscription.planId;
    }
    return r.code(200).send({ ok: true, data: { ...pair, deviceToken, ...(deviceError ? { deviceError } : {}), user: { id: v.userId, created: v.created, signupPlan } } });
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const raw = str(body(req as unknown as RouteRequest).refreshToken) || bearerOf(req as unknown as RouteRequest) || "";
    const now = new Date(d.now());
    const insp = await inspectToken(raw, ["refresh"], { now });
    if (insp.status === "unavailable") return fail(r, 503, "unavailable", "БД недоступна — повторите позже"); // транзиент ≠ разлогин
    const info = insp.status === "ok" ? insp.token : undefined;
    if (!info) return fail(r, 401, "invalid_refresh", "refresh-токен не принят");
    // Одноразовость АТОМАРНА: два параллельных refresh с одним токеном — пару получает тот, чей UPDATE отозвал
    // строку; второй видит «уже отозван» и уходит с 401 (раньше результат revokeToken игнорировался).
    const revoked = await revokeToken(info.hash, { now });
    if (!revoked) return fail(r, 401, "invalid_refresh", "refresh-токен уже использован");
    const pair = await issueSessionPair(info.userId, now, ipHashOf(req.ip));
    if (!pair) return fail(r, 503, "unavailable", "не удалось выдать токены");
    return r.code(200).send({ ok: true, data: pair });
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const authed = await authenticate(req as unknown as RouteRequest, ["access"]);
    if (!authed) return fail(r, 401, "unauthorized", "нужен access-токен");
    const now = new Date(d.now());
    await revokeToken(authed.tokenHash, { now });
    const refresh = str(body(req as unknown as RouteRequest).refreshToken);
    if (refresh) {
      const info = await verifyToken(refresh, ["refresh"], { now });
      if (info && info.userId === authed.userId) await revokeToken(info.hash, { now });
    }
    return r.code(200).send({ ok: true, data: { loggedOut: true } });
  });
}

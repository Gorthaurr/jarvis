/**
 * Гарды HTTP-роутов продукта (/v1/*): bearer access/device-токен → userId; админ — по роли аккаунта
 * ИЛИ по JARVIS_ADMIN_TOKEN ИЛИ (когда токен не задан) только с loopback. Ошибки — честные коды в теле
 * `{ok:false, error:{code, message}}`, без стек-трейсов и без раскрытия существования аккаунтов.
 */
import { timingSafeEqual } from "node:crypto";
import type { ProductPolicy } from "../policy.js";
import { verifyToken } from "../tokens.js";
import { getAccount } from "../accounts.js";

export interface AuthedRequest {
  userId: string;
  tokenKind: "access" | "device";
  deviceId?: string;
  /** sha256 предъявленного токена — для точечного отзыва (logout). */
  tokenHash: string;
}

interface ReqLike {
  headers: Record<string, unknown>;
  ip?: string;
}

interface ReplyLike {
  code: (n: number) => { send: (b: unknown) => unknown };
}

export function isLoopbackIp(ip: string | undefined): boolean {
  const v = String(ip ?? "").replace(/^::ffff:/, "");
  return v === "127.0.0.1" || v === "::1" || v === "localhost";
}

export function bearerOf(req: ReqLike): string | undefined {
  const h = req.headers["authorization"];
  const s = Array.isArray(h) ? h[0] : h;
  if (typeof s !== "string") return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(s.trim());
  return m?.[1]?.trim() || undefined;
}

/** Сравнение секретов без утечки по времени (разные длины → сразу false: длина токена не секрет). */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function fail(reply: ReplyLike, status: number, code: string, message: string): unknown {
  return reply.code(status).send({ ok: false, error: { code, message } });
}

/** Резолв пользователя по bearer-токену нужных видов. null → вызывающий отвечает 401. */
export async function authenticate(req: ReqLike, kinds: Array<"access" | "device">): Promise<AuthedRequest | null> {
  const raw = bearerOf(req);
  if (!raw) return null;
  const v = await verifyToken(raw, kinds);
  if (!v) return null;
  const acc = await getAccount(v.userId);
  if (acc && acc.status !== "active") return null; // blocked/deleted — как отсутствие токена
  return { userId: v.userId, tokenKind: v.kind as "access" | "device", deviceId: v.deviceId ?? undefined, tokenHash: v.hash };
}

/**
 * Админ-доступ: (1) заголовок x-jarvis-admin-token совпадает с политикой; (2) токен не задан — только
 * loopback; (3) авторизованный пользователь с ролью admin. Возвращает причину отказа для честного 403.
 */
export async function authorizeAdmin(req: ReqLike, policy: ProductPolicy, opts?: { exposed?: boolean }): Promise<{ ok: true; via: "token" | "loopback" | "role"; userId?: string } | { ok: false; message: string }> {
  const hdr = req.headers["x-jarvis-admin-token"];
  const given = (Array.isArray(hdr) ? hdr[0] : hdr) as string | undefined;
  if (policy.adminToken) {
    if (given && sameSecret(given, policy.adminToken)) return { ok: true, via: "token" };
  } else if (!opts?.exposed && isLoopbackIp(req.ip)) {
    // Фолбэк «loopback = админ» ТОЛЬКО на закрытом сервере: за прокси/туннелем req.ip = 127.0.0.1 у всех
    // (контроль-ревью 2026-09-02), поэтому при exposed админ-токен обязателен (boot это проверяет).
    return { ok: true, via: "loopback" };
  }
  const authed = await authenticate(req, ["access"]);
  if (authed) {
    const acc = await getAccount(authed.userId);
    if (acc?.role === "admin") return { ok: true, via: "role", userId: authed.userId };
  }
  return { ok: false, message: policy.adminToken ? "нужен админ-токен или роль admin" : "админ-доступ только с loopback или с ролью admin" };
}

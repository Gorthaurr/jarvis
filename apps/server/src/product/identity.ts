/**
 * Продуктовый резолвер идентичности hello-токена (план §2.2, §5.1). Gateway зовёт его ВМЕСТО
 * resolveAndProvision ТОЛЬКО при policy.enabled. При выключенном мастере вызова быть не должно; если
 * всё же позвали (ошибка проводки) — делегируем сегодняшнему резолверу БЕЗ своих проверок: поведение при
 * флаге 0 не меняется ни на байт.
 *
 * Маршрутизация ДО проверки UUID: префикс jdt_ → device-токен продукта (единственный судья — БД);
 * jat_/jrt_ в hello — не тот канал (это HTTP-токены) → честный unauthorized; всё остальное — как сегодня
 * (UUID-партиция / dev-token → DEV_USER), КРОМЕ облачной роли brain с включённым auth: там dev-token не
 * принимается — login_required. Скользящая ротация: device-токен старше ROTATE_AFTER_MS получает замену в
 * server.hello.rotatedToken; старый доживает хвост (tokens.ROTATED_TAIL_MS) — гонка reconnect.
 * Сообщения об отказе — честные и адресованы владельцу устройства (клиент показывает их как есть).
 */
import { query } from "../db/pool.js";
import { type Logger, createLogger } from "@jarvis/shared";
import { resolveAndProvision } from "../gateway/identity.js";
import type { ProductPolicy } from "./policy.js";
import { rotateDeviceToken } from "./tokens-lifecycle.js";
import { type TokenInfo, inspectToken, kindOfRaw, touchToken } from "./tokens.js";

const log: Logger = createLogger("product:identity");
const DAY_MS = 24 * 60 * 60 * 1000;
/** Срок device-токена (план: 365 дн со скользящей ротацией). */
export const DEVICE_TOKEN_TTL_MS = 365 * DAY_MS;
/** Возраст, после которого hello получает ротированный токен. */
export const ROTATE_AFTER_MS = 30 * DAY_MS;

export type IdentityErrorCode = "login_required" | "device_revoked" | "unauthorized" | "account_blocked" | "unavailable";
export type ProductIdentity =
  | { ok: true; userId: string; deviceId?: string; rotatedToken?: string }
  | { ok: false; code: IdentityErrorCode; message: string };

export interface HelloIdentity {
  token: string;
  installId?: string;
}

export interface ResolveIdentityOptions {
  now?: Date;
  /** Сервер открыт наружу (policy.exposed): dev-токен больше не путь владельца — только device-токен. */
  exposed?: boolean;
  /** Dev-сессия текст-драйвера: ротацию наследника не съедает и installId прислать не обязана. */
  devSession?: boolean;
  /** Env для делегированного пути (JARVIS_AUTH_STRICT / JARVIS_DEV_USER_ID) — как у resolveAndProvision. */
  env?: NodeJS.ProcessEnv;
}

function fail(code: IdentityErrorCode, message: string): ProductIdentity {
  return { ok: false, code, message };
}

export async function resolveProductIdentity(
  hello: HelloIdentity,
  policy: ProductPolicy,
  opts?: ResolveIdentityOptions,
): Promise<ProductIdentity> {
  const token = (hello.token ?? "").trim();
  if (!policy.enabled) return delegate(token, opts?.env);
  const kind = kindOfRaw(token);
  if (kind === "device") return resolveDevice(token, opts?.now ?? new Date(), hello.installId, opts?.devSession === true);
  if (kind) return fail("unauthorized", `токен вида «${kind}» в hello не принимается — нужен device-токен (jdt_)`);
  // Вход обязателен, когда сервер ДОСТУПЕН ИЗВНЕ (роль brain / JARVIS_ALLOW_REMOTE): на закрытом loopback-
  // стенде dev-токен остаётся путём владельца (ревью 2026-09-02: иначе «мозг» на открытом порту пускал бы
  // любого, кто пришлёт 'dev-token', в раздел DEV_USER).
  if (policy.auth && (policy.exposed || opts?.exposed === true)) {
    return fail(
      "login_required",
      policy.role === "brain" ? "облачный мозг принимает только device-токен продукта — войдите по коду с email" : "сервер открыт наружу — вход только по device-токену продукта (код с email)",
    );
  }
  return delegate(token, opts?.env);
}

/** Сегодняшний путь: UUID → партиция (strict — по auth_tokens), иначе dev-фолбэк. */
async function delegate(token: string, env: NodeJS.ProcessEnv | undefined): Promise<ProductIdentity> {
  const userId = await resolveAndProvision(token, env);
  return userId ? { ok: true, userId } : fail("unauthorized", "токен не верифицирован");
}

async function resolveDevice(token: string, now: Date, installId: string | undefined, devSession: boolean): Promise<ProductIdentity> {
  const r = await inspectToken(token, ["device"], { now });
  if (r.status === "unavailable") return fail("unavailable", "БД недоступна — повторите позже");
  if (r.status !== "ok" || !r.token) return rejectDevice(r.status, r.token);
  const t = r.token;
  // Токен привязан к установке: другая установка (скопированный токен) — не принимается; ОТСУТСТВИЕ installId у
  // привязанного токена — тоже отказ (иначе привязка обходилась бы неотправкой поля; исключение — dev-сессия
  // текст-драйвера). Регистр UUID нормализуется (registerDevice хранит lowercase). Отказ — login_required, не
  // device_revoked: клиент по device_revoked стирает свой токен, а тут его вина не доказана.
  const install = installId?.trim().toLowerCase() || undefined;
  if (t.deviceId) {
    const bound = await deviceInstallOf(t.deviceId);
    if (bound && !devSession && !install) return fail("login_required", "device-токен привязан к установке — клиент обязан прислать installId");
    if (bound && install && bound !== install) return fail("login_required", "device-токен выдан другой установке — войдите заново по коду с email");
  }
  void touchToken(t.hash, now);
  let rotatedToken: string | undefined;
  // Dev-сессия наследника не минтит: единственная выдача ушла бы текст-драйверу, а не Electron владельца.
  if (!devSession && now.getTime() - t.createdAt.getTime() >= ROTATE_AFTER_MS) {
    // Наследник минтится ОДИН раз (гард в rotateDeviceToken): повторный hello старым токеном в его хвосте
    // нового не плодит (ревью 2026-09-02) — null здесь штатен, не сбой.
    const fresh = await rotateDeviceToken(t.hash, DEVICE_TOKEN_TTL_MS, { now });
    if (fresh) rotatedToken = fresh.raw;
  }
  return { ok: true, userId: t.userId, deviceId: t.deviceId ?? undefined, rotatedToken };
}

/** install_id устройства (lowercase) или null — устройства нет / не привязано. */
async function deviceInstallOf(deviceId: string): Promise<string | null> {
  const res = await query<{ install_id: string | null }>("SELECT install_id FROM devices WHERE id = $1", [deviceId]);
  const v = res?.rows[0]?.install_id;
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}

function rejectDevice(status: string, token: TokenInfo | undefined): ProductIdentity {
  // Заблокированный/удалённый аккаунт — своим кодом, даже если токены уже отозваны блокировкой (иначе клиент
  // слышал «устройство отозвано» и стирал токен, а причина — аккаунт).
  if (token?.userStatus && token.userStatus !== "active") {
    return fail("account_blocked", token.userStatus === "deleted" ? "аккаунт удалён" : "аккаунт заблокирован");
  }
  switch (status) {
    case "revoked":
    case "device_revoked":
      return fail("device_revoked", "это устройство отозвано — войдите заново по коду с email");
    case "expired":
      return fail("login_required", "срок device-токена истёк — войдите заново по коду с email");
    case "user_inactive":
      return fail("unauthorized", token?.userStatus === "deleted" ? "аккаунт удалён" : "аккаунт заблокирован");
    default:
      return fail("unauthorized", "device-токен не найден");
  }
}

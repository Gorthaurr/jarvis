/**
 * Зависимости HTTP-роутов продукта — инжектируются из gateway (server.ts), чтобы роуты тестировались на
 * голом Fastify без поднятия мозга. Все побочные каналы (почта, часы, провайдер оплаты) — параметры.
 */
import type { UsageInfo } from "@jarvis/protocol";
import type { SpendGuards } from "../../billing/index.js";
import type { MailDelivery } from "../auth.js";
import type { PaymentProvider } from "../billing/provider.js";
import type { ProductPolicy } from "../policy.js";
import type { QuotaResolver } from "../quota.js";
import type { RateLimiter } from "../rate-limit.js";

export interface ProductRouteDeps {
  policy: ProductPolicy;
  spend: SpendGuards;
  quota: QuotaResolver;
  provider: PaymentProvider;
  limiter: RateLimiter;
  /** HMAC-перец email_hash (JARVIS_EMAIL_PEPPER или производная мастер-ключа). */
  pepper: string;
  /** Отправка кода входа: "sent" | "uncertain" (SmtpUncertainError → uncertain, не ложное «отправлено»). */
  sendMail: (email: string, code: string) => Promise<MailDelivery>;
  /** Шифратор адреса для email_enc (конфигурация (1) плана). null — адрес не хранится. */
  encryptor?: (email: string) => Buffer | null;
  now: () => number;
  /** Куда провайдер вернёт пользователя после оплаты (hosted-checkout). */
  returnUrl: string;
  /** Dev-эндпоинты: включены ТОЛЬКО за JARVIS_DEV_HTTP=1 + loopback + JARVIS_DEV_TOKEN (тот же devPre, что у /dev/*). */
  dev?: {
    preHandler: (req: unknown, reply: unknown) => Promise<unknown>;
  };
  /** Пул ключей-сообщений «по умолчанию для нового пользователя» — план триала при первом входе. */
  signupPlanId?: string;
  /**
   * UsageInfo пользователя С ПОДГРУЗКОЙ состояния (hydrate SpendGuard + точный ledger + лимиты плана):
   * HTTP-запрос может прийти раньше первого WS-коннекта после рестарта — иначе /v1/usage отвечал «0 из 0».
   */
  usageInfo: (userId: string) => Promise<UsageInfo>;
  /** Протолкнуть свежий баланс в живые сессии пользователя (после оплаты/гранта — до реконнекта). */
  pushUsage?: (userId: string) => Promise<void>;
  /** Сервер открыт наружу (policy.exposed) — loopback больше не значит «владелец за консолью». */
  exposed?: boolean;
}

/** Fastify-запрос в том минимуме, который нужен роутам (без завязки на generics плагина). */
export interface RouteRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  body?: unknown;
  params?: unknown;
  query?: unknown;
}

export interface RouteReply {
  code: (n: number) => RouteReply;
  header: (k: string, v: string) => RouteReply;
  send: (b: unknown) => unknown;
}

export const body = (req: RouteRequest): Record<string, unknown> => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
export const params = (req: RouteRequest): Record<string, string> => (req.params && typeof req.params === "object" ? (req.params as Record<string, string>) : {});
export const queryOf = (req: RouteRequest): Record<string, string> => (req.query && typeof req.query === "object" ? (req.query as Record<string, string>) : {});
export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

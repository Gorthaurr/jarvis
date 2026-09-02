/**
 * МАСТЕР-ПЕРЕКЛЮЧАТЕЛЬ ПРОДУКТОВОГО РЕЖИМА (требование владельца 2026-09-02): весь каркас пользователей —
 * аккаунты, токены, подписки, квоты, оплата, библиотека, телеметрия наружу — живёт ЗА ОДНИМ флагом
 * `JARVIS_PRODUCT_MODE`. Выключен (дефолт) = ровно сегодняшнее поведение: dev-token → DEV_USER, потолок
 * трат владельца, никаких новых роутов/логов/таблиц. Включён = путь пользователя продукта.
 *
 * ИНВАРИАНТ (проверяется тестом таблицей): ни один подфлаг не может быть true при мастере 0 — иначе
 * «продуктовый режим с одной случайно снятой галочкой» стал бы самым частым состоянием стенда, а
 * регресс dev-режима владельца — блокер.
 *
 * Подсистемы читают ЭТУ политику (config.product), не env напрямую: имена флагов — в одном месте.
 * Модель монетизации — решение ассистента по поручению владельца (docs/PRODUCT_FRAMEWORK_PLAN §4.4):
 * ГИБРИД — подписка за софт + пакеты кредитов «мозга проекта»; пока провайдер оплаты `none`, планы
 * выдаёт админ (демо для друзей), оплата реализована, но выключена.
 */
import { envBool } from "@jarvis/shared";

export type ProductRole = "all" | "node" | "brain";
export type BillingProviderKind = "none" | "fake" | "yookassa";

export interface ProductPolicy {
  /** Мастер: JARVIS_PRODUCT_MODE. */
  readonly enabled: boolean;
  /** Роль процесса (осмыслена только при enabled): all — как сегодня, node — узел без петли, brain — облачная петля. */
  readonly role: ProductRole;
  /** Аккаунты/device-токены/OTP; dev-token отвергается на облачных ролях. */
  readonly auth: boolean;
  /** Лимиты SpendGuard из плана + ledger + пороги 80/100. */
  readonly quotas: boolean;
  /** Подписки/инвойсы/вебхуки/checkout. */
  readonly billing: boolean;
  /** Узел ходит в LLM-прокси проекта вместо прямого Anthropic. */
  readonly llmProxy: boolean;
  /** Общая библиотека навыков с сервера проекта (деф ВЫКЛ даже при продукте). */
  readonly library: boolean;
  /** Телеметрия узел → облако (деф ВЫКЛ даже при продукте). */
  readonly telemetryEgress: boolean;
  /** Провайдер оплаты: none — checkout нет, планы даёт админ; fake — тестовый на loopback; yookassa — боевой. */
  readonly billingProvider: BillingProviderKind;
  readonly llmProxyUrl: string | undefined;
  /**
   * Сервер ДОСТУПЕН ИЗВНЕ: роль brain, JARVIS_ALLOW_REMOTE, JARVIS_TRUST_PROXY (за прокси) или явный
   * JARVIS_PRODUCT_EXPOSED=1 (loopback-bind за туннелем cloudflared/ngrok сервер сам не увидит — ЗАДАВАТЬ ЯВНО).
   * При exposed: админ-токен обязателен (loopback ≠ владелец), вход только по device-токену, fake-провайдер выключен.
   */
  readonly exposed: boolean;
  readonly brainUrl: string | undefined;
  /** Токен админ-эндпоинтов и отчётов (/v1/admin/*, /cogs при продукте). Пусто → админ-роуты только с loopback. */
  readonly adminToken: string | undefined;
  /** Зафиксированная модель монетизации (документируется в паспорте возможностей и отчётах). */
  readonly monetization: "hybrid";
}

/** Политика при выключенном мастере — единственный источник «как сегодня». */
export const PRODUCT_OFF: ProductPolicy = Object.freeze({
  enabled: false,
  role: "all",
  auth: false,
  quotas: false,
  billing: false,
  llmProxy: false,
  library: false,
  telemetryEgress: false,
  billingProvider: "none",
  llmProxyUrl: undefined,
  brainUrl: undefined,
  adminToken: undefined,
  monetization: "hybrid",
  exposed: false,
});

const ROLES: ReadonlySet<string> = new Set(["all", "node", "brain"]);
const PROVIDERS: ReadonlySet<string> = new Set(["none", "fake", "yookassa"]);

function opt(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = source[name];
  const t = v === undefined ? "" : v.trim();
  return t ? t : undefined;
}

/** Чистая функция: env → политика. Источник инжектируется ради тестов таблицей режимов. */
export function resolveProductFlags(source: NodeJS.ProcessEnv = process.env): ProductPolicy {
  if (!envBool("JARVIS_PRODUCT_MODE", false, source)) return PRODUCT_OFF;
  const roleRaw = (opt(source, "JARVIS_ROLE") ?? "all").toLowerCase();
  const providerRaw = (opt(source, "JARVIS_BILLING_PROVIDER") ?? "none").toLowerCase();
  const billing = envBool("JARVIS_PRODUCT_BILLING", true, source);
  return {
    enabled: true,
    role: (ROLES.has(roleRaw) ? roleRaw : "all") as ProductRole,
    auth: envBool("JARVIS_PRODUCT_AUTH", true, source),
    quotas: envBool("JARVIS_PRODUCT_QUOTAS", true, source),
    billing,
    llmProxy: envBool("JARVIS_PRODUCT_LLM_PROXY", true, source) && Boolean(opt(source, "JARVIS_LLM_PROXY_URL")),
    library: envBool("JARVIS_PRODUCT_LIBRARY", false, source),
    telemetryEgress: envBool("JARVIS_PRODUCT_TELEMETRY", false, source),
    billingProvider: (billing && PROVIDERS.has(providerRaw) ? providerRaw : "none") as BillingProviderKind,
    llmProxyUrl: opt(source, "JARVIS_LLM_PROXY_URL"),
    brainUrl: opt(source, "JARVIS_BRAIN_URL"),
    adminToken: opt(source, "JARVIS_ADMIN_TOKEN"),
    monetization: "hybrid",
    exposed:
      roleRaw === "brain" || envBool("JARVIS_PRODUCT_EXPOSED", false, source) || envBool("JARVIS_ALLOW_REMOTE", false, source) || Boolean(opt(source, "JARVIS_TRUST_PROXY")),
  };
}

/** Одна строка для boot-лога/паспорта: что включено. */
export function describeProductPolicy(p: ProductPolicy): string {
  if (!p.enabled) return "product mode OFF";
  const on = (["auth", "quotas", "billing", "llmProxy", "library", "telemetryEgress"] as const).filter((k) => p[k]);
  return `PRODUCT MODE ON role=${p.role} on=[${on.join(",")}] billing=${p.billingProvider} monetization=${p.monetization} exposed=${p.exposed}`;
}

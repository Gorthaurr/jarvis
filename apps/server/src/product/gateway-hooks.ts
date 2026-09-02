/**
 * ПРОДУКТОВЫЙ РАНТАЙМ ДЛЯ GATEWAY — одна точка, через которую server.ts/router-ws.ts трогают каркас:
 * идентичность на handshake, лимиты плана после провижна, ledger-приёмник расхода (+ списание кредитов
 * пакетов), UsageInfo для вкладки «Оплата», выбор модели пользователем, пороги 80/100, таймер жизненного
 * цикла подписок, зависимости HTTP-роутов.
 *
 * ПРИ МАСТЕР-ФЛАГЕ 0: `resolveHello` делегирует прежнему resolveAndProvision, `afterProvision`/`usageInfoFor`/
 * `usageSinkFor`/`quotaExhaustedText` отдают undefined, пороги не вешаются, таймер не стартует — gateway ведёт
 * себя байт-в-байт как раньше. Работает в обоих режимах ТОЛЬКО выбор модели (это выбор пользователя на его
 * машине; при пустом выборе — дефолтная лестница, т.е. ничего не меняется).
 *
 * Контроль-ревью 2026-09-02 (два прохода) — что закрыто здесь:
 * - «открыт наружу» = `policy.exposed` (brain / ALLOW_REMOTE / TRUST_PROXY / явный PRODUCT_EXPOSED), а не
 *   только ALLOW_REMOTE: за прокси/туннелем loopback ничего не доказывает — fake-провайдер, loopback-админ и
 *   dev-токен в hello отключаются по нему;
 * - смена МЕСЯЦА внутри живого процесса: лимиты плана применяются к КАЖДОМУ периоду (`ensureLoaded` по
 *   периоду, зовётся из sink/usage/порогов) — без этого списание кредитов сжигало пакет за расход, покрытый
 *   квотой плана, а кап прошлого месяца жил в новом;
 * - точный spent после рестарта: `hydrate({source:"ledger"})` читает cost_micro, а не cost_estimate
 *   (NUMERIC 12,2 округляет каждый раунд до цента → +67% на мелких ходах);
 * - пороги: уведомители per-SESSION (rebind при resume не оставляет призрака с мёртвым пайплайном), durable
 *   отметка ставится по факту ПРИЁМА и откатывается по `onOutcome(false)` (реплика выброшена по TTL/«стоп»/
 *   смерти сессии — предупредим снова), доставка сериализована per-user (два подключения ≠ два предупреждения);
 * - обрыв стрима (usage нулевой): стоимость ОЦЕНИВАЕТСЯ по размеру промпта и учитывается (ledger estimated +
 *   SpendGuard), стаб без вызова API не пишется вовсе;
 * - kill-switch админа — свойство пользователя (bool_or по всем периодам), не строки текущего месяца.
 */
import type { Hello, ModelsCatalog, UsageInfo } from "@jarvis/protocol";
import { type Logger, type ResolvedModels, type TierModels, createLogger } from "@jarvis/shared";
import type { UsageSinkEvent } from "../brain/agent/index.js";
import { mailConfig } from "../brain/tools/handlers/mail.js";
import { type SpendGuards, type ThresholdKind } from "../billing/index.js";
import type { ServerConfig } from "../config.js";
import { encryptSecret } from "../db/crypto.js";
import { query } from "../db/pool.js";
import { isDevSession } from "../gateway/dev-session.js";
import { SmtpUncertainError, buildMessageId, smtpSend } from "../integrations/smtp.js";
import { costMicroUsd } from "../obs/pricing.js";
import { getAccount } from "./accounts.js";
import type { MailDelivery } from "./auth.js";
import type { PaymentProvider } from "./billing/provider.js";
import { FakePaymentProvider } from "./billing/providers/fake.js";
import { NonePaymentProvider } from "./billing/providers/none.js";
import { YooKassaProvider } from "./billing/providers/yookassa.js";
import { type ProductIdentity, resolveProductIdentity } from "./identity.js";
import { periodOf, recordLedger } from "./ledger.js";
import { allowedSetFrom, buildModelsCatalog, effectiveModelsFor, modelChoiceFor } from "./models.js";
import { resolvePepper } from "./pepper.js";
import type { ProductPolicy } from "./policy.js";
import { QuotaResolver } from "./quota.js";
import { RateLimiter } from "./rate-limit.js";
import type { ProductRouteDeps } from "./routes/deps.js";
import { effectivePlanFor, sweepLifecycle } from "./subscriptions.js";

const log: Logger = createLogger("product");

/** Период проверки жизненного цикла подписок (trialing→expired, active→past_due→expired). */
export const LIFECYCLE_SWEEP_MS = 10 * 60 * 1000;

/**
 * Уведомитель порога: возвращает, ПРИНЯТА ли реплика (true/undefined — в очереди озвучки, false — нет);
 * `onOutcome(spoken)` сообщает реальный исход — выброшенная реплика откатывает durable-отметку.
 */
export type ThresholdNotify = (kind: ThresholdKind, usage: UsageInfo, onOutcome: (spoken: boolean) => void) => boolean | void;

export interface HelloUser {
  id: string;
  planId?: string;
  status?: string;
  role?: string;
}

export interface ProductRuntime {
  readonly policy: ProductPolicy;
  readonly quota: QuotaResolver;
  readonly provider: PaymentProvider;
  routeDeps(dev?: ProductRouteDeps["dev"]): ProductRouteDeps;
  resolveHello(hello: Hello): Promise<ProductIdentity>;
  afterProvision(userId: string): Promise<HelloUser | undefined>;
  usageInfoFor(userId: string): Promise<UsageInfo | undefined>;
  usageSinkFor(userId: string): ((e: UsageSinkEvent) => void) | undefined;
  quotaExhaustedText(): string | undefined;
  /** Синхронно: выбор пользователя поверх дефолтов, БЕЗ фильтра плана (только когда квот нет). */
  modelsSync(userId: string): TierModels;
  /** С фильтром плана (при квотах) — уточнение после handshake/смены настроек. */
  modelsFor(userId: string): Promise<ResolvedModels>;
  modelsCatalogFor(userId: string): Promise<ModelsCatalog>;
  /** Каталог, когда фильтр плана недоступен (БД): применены ДЕФОЛТЫ, выбор помечен `unavailable` — панель не врёт. */
  modelsCatalogFallback(userId: string): ModelsCatalog;
  attachThreshold(userId: string, sessionId: string, notify: ThresholdNotify, pushUsage?: (u: UsageInfo) => void): void;
  detachThreshold(userId: string, sessionId: string): void;
  /**
   * Протолкнуть СВЕЖИЙ баланс во все живые сессии пользователя. Нужен сразу после оплаты: живой прогон
   * 2026-09-02 показал «заплатил — не заработало» (кредиты в базе есть, потолок вырос, а открытая
   * вкладка и сам Джарвис до реконнекта продолжали говорить «кредиты исчерпаны»).
   */
  pushUsage(userId: string): Promise<void>;
  /** Таймер жизненного цикла подписок — из gateway.listen()/close(); при флаге 0 — no-op. */
  start(): void;
  stop(): void;
}

export const QUOTA_EXHAUSTED_TEXT = "Кредиты тарифа исчерпаны, сэр — продлите план или добавьте свой ключ в настройках.";

function makeProvider(policy: ProductPolicy, env: NodeJS.ProcessEnv): PaymentProvider {
  if (policy.billingProvider === "fake") {
    if (policy.exposed) {
      log.error("JARVIS_BILLING_PROVIDER=fake на сервере, открытом наружу (exposed) — провайдер ВЫКЛЮЧЕН (none): фейковый вебхук выдавал бы подписки любому");
      return new NonePaymentProvider();
    }
    return new FakePaymentProvider((env.JARVIS_FAKE_WEBHOOK_SECRET ?? "").trim() || undefined);
  }
  if (policy.billingProvider === "yookassa") {
    const shopId = (env.JARVIS_YOOKASSA_SHOP_ID ?? "").trim();
    const secretKey = (env.JARVIS_YOOKASSA_SECRET_KEY ?? "").trim();
    if (shopId && secretKey) return new YooKassaProvider({ shopId, secretKey });
    log.warn("JARVIS_BILLING_PROVIDER=yookassa без JARVIS_YOOKASSA_SHOP_ID/SECRET_KEY — провайдер оплаты ВЫКЛЮЧЕН (none)");
  }
  return new NonePaymentProvider();
}

/** Отправка кода входа через SMTP владельца (.env MAIL_*). Не настроено → исключение → requestOtp: send_failed. */
async function sendOtpMail(email: string, code: string): Promise<MailDelivery> {
  const cfg = mailConfig();
  if (!cfg) throw new Error("почта не настроена (MAIL_SMTP_HOST/MAIL_USER/MAIL_PASSWORD) — код входа отправить нечем");
  try {
    await smtpSend(cfg.smtp, {
      to: [email],
      subject: "Код входа в Jarvis",
      body: `Ваш код входа: ${code}\nДействует 10 минут. Если вы не запрашивали код — просто проигнорируйте письмо.`,
      messageId: buildMessageId(cfg.smtp.from),
    });
    return "sent";
  } catch (e) {
    if (e instanceof SmtpUncertainError) return "uncertain";
    throw e;
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createProductRuntime(config: ServerConfig, spend: SpendGuards, opts: { now?: () => number; env?: NodeJS.ProcessEnv } = {}): ProductRuntime {
  const policy = config.product;
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => Date.now());
  const quota = new QuotaResolver({
    defaultPlanId: (env.JARVIS_PRODUCT_DEFAULT_PLAN ?? "").trim() || undefined,
    defaultCapUsd: config.defaultSpendCap,
    byoSupported: policy.llmProxy,
    now,
  });
  const provider = makeProvider(policy, env);
  const limiter = new RateLimiter();
  const pepper = policy.enabled ? resolvePepper(env) : "";
  const storeEmail = (env.JARVIS_EMAIL_STORE ?? "").trim() === "1";
  const cacheTtl = (env.ANTHROPIC_CACHE_TTL ?? "").trim() === "1h" ? "1h" : "5m";
  /** userId → sessionId → уведомитель (per-session: rebind при resume перезаписывает свой sessionId, призрака нет). */
  const notifiers = new Map<string, Map<string, ThresholdNotify>>();
  /** userId → sessionId → канал доставки свежего снимка расхода в живую сессию (вкладка «Оплата»). */
  const usagePushers = new Map<string, Map<string, (u: UsageInfo) => void>>();
  const attached = new Set<string>();
  /** userId → период ('YYYY-MM'), для которого SpendGuard гидрирован по ledger и получил лимиты плана. */
  const appliedPeriod = new Map<string, string>();
  /** Сериализация доставки порогов per-user: два одновременных подключения не дают два предупреждения. */
  const delivering = new Map<string, Promise<void>>();
  let sweepTimer: NodeJS.Timeout | null = null;

  /**
   * Лимиты плана и точный spent для ТЕКУЩЕГО периода. Идемпотентно на период: первый вызов после handshake /
   * HTTP-запроса / смены месяца делает hydrate(ledger) + applyTo; метка ставится ТОЛЬКО после успеха (сбой БД
   * не оставляет пользователя на платформенном капе до следующего handshake).
   */
  const ensureLoaded = async (userId: string): Promise<void> => {
    if (!policy.quotas) return;
    const period = periodOf(now());
    if (appliedPeriod.get(userId) === period) return;
    await spend.forUser(userId).hydrate({ source: "ledger" });
    await quota.applyTo(spend, userId);
    appliedPeriod.set(userId, period);
  };

  const usageInfoFor = async (userId: string): Promise<UsageInfo | undefined> => {
    if (!policy.quotas) return undefined;
    await ensureLoaded(userId);
    return quota.usageInfoFor(userId, spend.snapshot(userId), now());
  };

  const allowedFor = async (userId: string): Promise<string[] | null> =>
    policy.enabled && policy.quotas ? (await quota.limitsFor(userId)).modelsAllowed : null;

  const deliverOnce = async (userId: string, kind: ThresholdKind): Promise<void> => {
    const period = periodOf(now());
    const warnKind = kind === "soft" ? "80" : "100";
    const state = await quota.warnedState(userId, period);
    if (warnKind === "80" ? state.warned80At !== null : state.warned100At !== null) return; // уже предупреждали в этом периоде
    const usage = await usageInfoFor(userId);
    if (!usage) return;
    let accepted = 0;
    let spoken = false;
    const onOutcome = (ok: boolean): void => {
      if (ok) {
        spoken = true;
        return;
      }
      accepted -= 1;
      // Все принявшие каналы выбросили реплику (TTL/«стоп»/смерть сессии) — отметку снимаем, предупредим снова.
      if (accepted <= 0 && !spoken) void quota.unmarkWarned(userId, period, warnKind).catch((e) => log.warn("порог квоты: откат отметки не удался", errText(e)));
    };
    for (const notify of notifiers.get(userId)?.values() ?? []) {
      try {
        if (notify(kind, usage, onOutcome) !== false) accepted += 1;
      } catch (e) {
        log.warn("порог квоты: уведомитель упал", { userId, error: errText(e) });
      }
    }
    if (accepted > 0) await quota.markWarned(userId, period, warnKind, now());
    else log.info("порог квоты: живой сессии нет — предупреждение прозвучит при следующем подключении", { userId, kind });
  };

  const deliverThreshold = (userId: string, kind: ThresholdKind): Promise<void> => {
    const prev = delivering.get(userId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => deliverOnce(userId, kind));
    delivering.set(userId, run);
    void run.catch(() => undefined).then(() => {
      if (delivering.get(userId) === run) delivering.delete(userId);
    });
    return run;
  };

  /** На подключении: порог уже пересечён (после рестарта SpendGuard не «пересекает» его заново) — доставить сейчас. */
  const fireIfDue = async (userId: string): Promise<void> => {
    await ensureLoaded(userId);
    const snap = spend.snapshot(userId);
    if (!(snap.cap > 0)) return;
    const pct = (snap.spent / snap.cap) * 100;
    const state = await quota.warnedState(userId, periodOf(now()));
    if (pct >= 100) await deliverThreshold(userId, "hard");
    else if (pct >= state.softPct) await deliverThreshold(userId, "soft");
  };

  const runtime: ProductRuntime = {
    policy,
    quota,
    provider,
    routeDeps: (dev) => ({
      policy,
      spend,
      quota,
      provider,
      limiter,
      pepper,
      sendMail: sendOtpMail,
      ...(storeEmail ? { encryptor: (email: string) => encryptSecret(email) } : {}),
      now,
      returnUrl: (env.JARVIS_YOOKASSA_RETURN_URL ?? "").trim() || "https://example.invalid/paid",
      ...(dev ? { dev } : {}),
      signupPlanId: (env.JARVIS_PRODUCT_SIGNUP_PLAN ?? "trial").trim() || undefined,
      usageInfo: async (userId) => (await usageInfoFor(userId)) ?? quota.usageInfoFor(userId, spend.snapshot(userId), now()),
      // Оплата/грант/синтетический расход обязаны доехать до ОТКРЫТОГО приложения, а не ждать реконнекта.
      pushUsage: async (userId) => {
        await runtime.pushUsage(userId);
      },
      exposed: policy.exposed,
    }),
    resolveHello: (hello) =>
      resolveProductIdentity({ token: hello.token, installId: hello.installId }, policy, {
        now: new Date(now()),
        env,
        exposed: policy.exposed,
        devSession: isDevSession(hello.clientVersion),
      }),
    async afterProvision(userId) {
      if (!policy.enabled) return undefined;
      const out: HelloUser = { id: userId };
      if (policy.quotas) {
        // handshake уже сделал hydrate(ledger); лимиты плана — на текущий период.
        const limits = await quota.applyTo(spend, userId);
        appliedPeriod.set(userId, periodOf(now()));
        out.planId = limits.planId ?? undefined;
        out.status = limits.status;
        // Durable kill-switch админа — свойство пользователя: bool_or по всем периодам (стоп в сентябре
        // действует и в октябре; in-memory флаг иначе умирал с рестартом).
        const ks = await query<{ ks: boolean | null }>("select bool_or(kill_switch) as ks from usage_quota where user_id = $1", [userId]);
        if (ks?.rows[0]?.ks === true) spend.forUser(userId).engageKillSwitch();
      } else {
        const eff = await effectivePlanFor(userId, now());
        if (eff) {
          out.planId = eff.plan.id;
          out.status = eff.status;
        }
      }
      const acc = await getAccount(userId);
      if (acc) out.role = acc.role;
      return out;
    },
    usageInfoFor,
    usageSinkFor: (userId) =>
      policy.quotas
        ? (e) => {
            if (e.stubbed) return; // стаб без вызова API: ни расхода, ни строки ledger
            void (async () => {
              await ensureLoaded(userId); // смена месяца → лимиты нового периода ДО записи и списания
              const zeroUsage = e.usage.inputTokens === 0 && e.usage.outputTokens === 0;
              const estimateIn = zeroUsage && e.channel === "api" ? Math.max(0, Math.round(e.promptTokensEstimate ?? 0)) : 0;
              let costMicro = Math.round(e.costUsd * 1_000_000);
              let usage = e.usage;
              if (estimateIn > 0) {
                // Обрыв стрима до usage-события: провайдер счёт выставит, а нам пришли нули. Оцениваем по размеру
                // промпта (только input) — и в ledger (estimated), и в SpendGuard, иначе квота обходится обрывами.
                usage = { inputTokens: estimateIn, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
                costMicro = costMicroUsd(e.model, usage, { cacheTtl });
                spend.forUser(userId).recordUsage(e.taskId, estimateIn, costMicro / 1e6);
              }
              await recordLedger({
                userId,
                ts: now(),
                taskId: e.taskId,
                round: e.round,
                kind: "llm",
                model: e.model,
                usage,
                costMicro,
                channel: "node",
                estimated: estimateIn > 0,
              });
              await quota.settleCredits(userId); // перерасход сверх квоты плана — с кредитов пакетов
            })().catch((err) => log.warn("ledger: запись/списание расхода не удались", errText(err)));
          }
        : undefined,
    quotaExhaustedText: () => (policy.quotas ? QUOTA_EXHAUSTED_TEXT : undefined),
    modelsSync: (userId) => effectiveModelsFor(config.models, userId, null).models,
    modelsFor: async (userId) => effectiveModelsFor(config.models, userId, allowedSetFrom(await allowedFor(userId))),
    modelsCatalogFor: async (userId) => buildModelsCatalog(config.models, modelChoiceFor(userId), await allowedFor(userId)),
    modelsCatalogFallback(userId) {
      const chosen = modelChoiceFor(userId) ?? {};
      const base = buildModelsCatalog(config.models, undefined, null);
      const rejected: ModelsCatalog["rejected"] = [];
      if (chosen.primary) rejected.push({ slot: "primary", id: chosen.primary, reason: "unavailable" });
      if (chosen.strong) rejected.push({ slot: "strong", id: chosen.strong, reason: "unavailable" });
      return { ...base, chosen, rejected };
    },
    async pushUsage(userId) {
      const bySession = usagePushers.get(userId);
      if (!bySession || bySession.size === 0) return;
      const usage = await usageInfoFor(userId);
      if (!usage) return;
      for (const push of bySession.values()) {
        try {
          push(usage);
        } catch (e) {
          log.warn("свежий баланс: доставка в сессию не удалась", { userId, error: errText(e) });
        }
      }
    },
    attachThreshold(userId, sessionId, notify, pushUsage) {
      if (!policy.quotas) return;
      let bySession = notifiers.get(userId);
      if (!bySession) {
        bySession = new Map();
        notifiers.set(userId, bySession);
      }
      bySession.set(sessionId, notify);
      if (pushUsage) {
        let pushers = usagePushers.get(userId);
        if (!pushers) {
          pushers = new Map();
          usagePushers.set(userId, pushers);
        }
        pushers.set(sessionId, pushUsage);
      }
      if (!attached.has(userId)) {
        attached.add(userId);
        spend.forUser(userId).onThreshold((kind) => {
          deliverThreshold(userId, kind).catch((err) => log.warn("порог квоты: уведомление не удалось", errText(err)));
        });
      }
      fireIfDue(userId).catch((err) => log.warn("порог квоты: проверка на подключении не удалась", errText(err)));
    },
    detachThreshold(userId, sessionId) {
      notifiers.get(userId)?.delete(sessionId);
      usagePushers.get(userId)?.delete(sessionId);
    },
    start() {
      if (!policy.enabled || sweepTimer) return;
      const tick = (): void => {
        void (async () => {
          const transitions = await sweepLifecycle(now());
          if (transitions.length === 0) return;
          log.info("жизненный цикл подписок", { transitions: transitions.map((t) => `${t.planId}:${t.from}→${t.to}`) });
          if (!policy.quotas) return;
          // Переход (expired/past_due) меняет кап — применяем к SpendGuard сразу, не дожидаясь реконнекта.
          for (const userId of new Set(transitions.map((t) => t.userId))) {
            await quota.applyTo(spend, userId);
            appliedPeriod.set(userId, periodOf(now()));
          }
        })().catch((err) => log.warn("sweep подписок не удался", errText(err)));
      };
      sweepTimer = setInterval(tick, LIFECYCLE_SWEEP_MS);
      sweepTimer.unref();
      tick();
    },
    stop() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    },
  };
  return runtime;
}

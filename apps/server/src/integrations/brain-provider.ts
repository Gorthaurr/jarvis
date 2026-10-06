/** Единственная точка выбора мозга; no-API режимы не создают Anthropic-провайдер. */
import type { Logger } from "@jarvis/shared";
import type { ServerConfig } from "../config.js";
import type { ILlmProvider } from "./llm.js";
import { AnthropicLlmProvider } from "./anthropic.js";
import { FallbackLlmProvider } from "./fallback-llm.js";
import { SubscriptionLlmProvider } from "./subscription-llm.js";
import { createNoApiLlm } from "./no-api-llm.js";
import { describeProductPolicy } from "../product/policy.js";

export function createBrainProvider(config: ServerConfig, log: Logger): ILlmProvider {
  // Личный режим без API: Codex/ChatGPT или локальный Ollama. Старый Claude — явная альтернатива.
  let anthropicLlm: ILlmProvider;
  const noApiLlm = createNoApiLlm(config.product.enabled);
  if (noApiLlm) {
    anthropicLlm = noApiLlm;
    log.info("мозг без платного API", { provider: process.env.LLM_PROVIDER });
  } else {
    const apiLlm = new AnthropicLlmProvider({
      apiKey: config.anthropicApiKey,
      cacheTtl: config.anthropicCacheTtl,
      baseUrl: config.anthropicBaseUrl,
    });
    // ВОЛНА G: РЕЗЕРВ НА ПОДПИСКЕ. Кончился кредит API / лимит / сеть → ход уходит в Claude Max через
    // Agent SDK вместо стаба «связь прервалась» (см. integrations/subscription-llm.ts — там же честно
    // расписано, чем резерв ХУЖЕ основного канала: нет наших кеш-брейкпоинтов, история идёт текстом).
    // Резерв активируется САМ и только при реальном отказе основного; выключатель JARVIS_SUBSCRIPTION_FALLBACK=0.
    anthropicLlm = apiLlm;
    if (config.product.enabled) {
      // ПРОДУКТОВЫЙ РЕЖИМ (2026-09-02): резерв на ЛИЧНОЙ подписке владельца НЕ конструируется вовсе —
      // «отдавать этот канал другим людям нельзя» (subscription-llm.ts). Не «выключен флагом», а
      // отсутствует по построению. Заданный токен подписки в продуктовом профиле — отказ старта: иначе
      // пользователи продукта молча жили бы на подписке владельца. Файл ~/.claude/.credentials.json
      // (он есть на машине владельца всегда) — не повод не стартовать, лишь предупреждение.
      if ((process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim()) {
        throw new Error(
          "PRODUCT MODE: задан CLAUDE_CODE_OAUTH_TOKEN — личная подписка владельца не может обслуживать пользователей продукта; уберите переменную из продуктового профиля env",
        );
      }
      log.info(describeProductPolicy(config.product));
      log.info("резерв мозга на подписке в продуктовом режиме НЕ создаётся (канал личный, не для пользователей)");
    } else {
      const subscriptionLlm = new SubscriptionLlmProvider();
      anthropicLlm = new FallbackLlmProvider(apiLlm, subscriptionLlm);
      if (subscriptionLlm.live) {
        log.info("резерв мозга на подписке ГОТОВ (Claude Max через Agent SDK)", { auth: SubscriptionLlmProvider.authMode() });
        void subscriptionLlm.warmup(); // fire-and-forget: первый ход владельца не платит за холодный старт
      } else {
        log.warn(`резерв мозга на подписке НЕ активен: ${SubscriptionLlmProvider.unavailableReason()}`);
      }
    }
  }
  return anthropicLlm;
}

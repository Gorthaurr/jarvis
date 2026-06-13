/**
 * LLM-провайдер (Anthropic) — тонкий клиент (§7, §15).
 *
 * Интерфейс ILlmProvider абстрагирует тир/модель. Реальная реализация вызывает
 * Anthropic SDK, ЕСЛИ задан ANTHROPIC_API_KEY и установлен @anthropic-ai/sdk;
 * иначе — стаб (детерминированный ответ-заглушка), чтобы dev-срез работал без сети.
 *
 * Кеширование системного префикса (§15) закладывается через раздельные блоки
 * system: первый блок (персона) помечается cache_control. SDK импортируется
 * динамически, чтобы отсутствие пакета не ломало импорт модуля (§17 M0).
 */
import {
  type Tier,
  backoffMs,
  type Logger,
  createLogger,
  sleep,
} from "@jarvis/shared";

const log: Logger = createLogger("llm");

/** Сообщение чата. */
export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

/** Запрос к LLM. */
export interface LlmRequest {
  tier: Tier;
  /** Модель (id для тира уже разрешён вызывающим из config.models). */
  model: string;
  /** Кешируемый системный префикс (персона, §15). */
  systemStatic: string;
  /** Динамический хвост системы (контекст юзера). */
  systemDynamic?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
}

/** Ответ LLM. */
export interface LlmResponse {
  text: string;
  /** Использование токенов — вход в биллинг (§14). */
  usage: { inputTokens: number; outputTokens: number };
  /** true, если ответ синтезирован стабом (без реального вызова). */
  stubbed: boolean;
}

export interface ILlmProvider {
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** Доступен ли реальный бэкенд (есть ключ и SDK). */
  readonly live: boolean;
}

/** Параметры конструктора провайдера. */
export interface AnthropicConfig {
  apiKey: string | undefined;
  /** Сколько ретраев при недоступности (§7). */
  maxRetries?: number;
}

/**
 * Провайдер Anthropic с фоллбэком в стаб.
 * tier0 сюда не приходит — он обрабатывается без LLM (router/agent §7).
 */
export class AnthropicLlmProvider implements ILlmProvider {
  readonly live: boolean;
  private readonly apiKey: string | undefined;
  private readonly maxRetries: number;
  // Кешируем динамически импортированный клиент.
  private clientPromise: Promise<unknown> | null = null;

  constructor(cfg: AnthropicConfig) {
    this.apiKey = cfg.apiKey;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.live = Boolean(cfg.apiKey);
    if (!this.live) {
      log.warn("ANTHROPIC_API_KEY не задан — LLM работает в стаб-режиме");
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.live) return this.stub(req);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.callReal(req);
      } catch (e) {
        lastErr = e;
        const wait = backoffMs(attempt);
        log.warn("LLM-вызов не удался, ретрай", {
          attempt,
          waitMs: wait,
          error: e instanceof Error ? e.message : String(e),
        });
        await sleep(wait);
      }
    }
    log.error("LLM недоступен после ретраев — стаб-ответ", {
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    return this.stub(req);
  }

  /** Реальный вызов через @anthropic-ai/sdk (динамический импорт). */
  private async callReal(req: LlmRequest): Promise<LlmResponse> {
    const client = await this.getClient();
    // Типизируем минимально — SDK не обязан присутствовать в типах сборки.
    const anthropic = client as {
      messages: {
        create(args: unknown): Promise<{
          content: Array<{ type: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
        }>;
      };
    };

    // §15: первый системный блок кешируется (cache_control).
    const system = [
      { type: "text", text: req.systemStatic, cache_control: { type: "ephemeral" } },
      ...(req.systemDynamic ? [{ type: "text", text: req.systemDynamic }] : []),
    ];

    const resp = await anthropic.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.4,
      system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return {
      text,
      usage: {
        inputTokens: resp.usage?.input_tokens ?? 0,
        outputTokens: resp.usage?.output_tokens ?? 0,
      },
      stubbed: false,
    };
  }

  private getClient(): Promise<unknown> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const mod = await import("@anthropic-ai/sdk");
      const Anthropic = (mod.default ?? (mod as { Anthropic?: unknown }).Anthropic) as new (
        opts: { apiKey: string },
      ) => unknown;
      return new Anthropic({ apiKey: this.apiKey! });
    })();
    return this.clientPromise;
  }

  /** Детерминированный стаб-ответ (без сети) для dev-среза (§17). */
  private stub(req: LlmRequest): LlmResponse {
    const last = req.messages.at(-1)?.content ?? "";
    return {
      text: `(стаб LLM, тир ${req.tier}) Пока не подключена модель. Вы сказали: «${last.slice(0, 80)}».`,
      usage: { inputTokens: 0, outputTokens: 0 },
      stubbed: true,
    };
  }
}

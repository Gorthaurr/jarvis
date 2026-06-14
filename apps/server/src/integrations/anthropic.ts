/**
 * LLM-провайдер Anthropic с поддержкой tool-use (§7, §8, §15).
 *
 * Реализует ILlmProvider (llm.ts). Реальный вызов через @anthropic-ai/sdk при
 * наличии ANTHROPIC_API_KEY; иначе — детерминированный стаб (без сети, без tool-use).
 * Первый системный блок (персона) помечается cache_control (§15). SDK импортируется
 * динамически — отсутствие пакета не ломает импорт модуля.
 */
import { type Logger, backoffMs, createLogger, sleep } from "@jarvis/shared";
import type {
  ILlmProvider,
  LlmContentBlock,
  LlmRequest,
  LlmResponse,
  StopReason,
  ToolUse,
} from "./llm.js";

const log: Logger = createLogger("llm:anthropic");

export interface AnthropicConfig {
  apiKey: string | undefined;
  maxRetries?: number;
  /** TTL prompt-кеша (§15): "5m" (дефолт) или "1h" (extended, beta-заголовок). */
  cacheTtl?: "5m" | "1h";
  /** Base URL — для шлюза/прокси (proxyapi.ru и т.п.); по умолчанию прямой Anthropic. */
  baseUrl?: string;
}

/** Сырые типы ответа SDK (минимально). */
interface RawContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface RawResponse {
  content: RawContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export class AnthropicLlmProvider implements ILlmProvider {
  readonly live: boolean;
  private readonly apiKey: string | undefined;
  private readonly maxRetries: number;
  private readonly cacheTtl: "5m" | "1h";
  private readonly baseUrl: string | undefined;
  private clientPromise: Promise<unknown> | null = null;

  constructor(cfg: AnthropicConfig) {
    this.apiKey = cfg.apiKey;
    // Голос: быстро падать, а не висеть. 1 ретрай (транзиентный блип), не 3 —
    // мёртвый шлюз не должен тормозить ответ на 6.5с (см. грабли oneprovider).
    this.maxRetries = cfg.maxRetries ?? 1;
    this.cacheTtl = cfg.cacheTtl ?? "5m";
    this.baseUrl = cfg.baseUrl;
    this.live = Boolean(cfg.apiKey);
    if (!this.live) log.warn("ANTHROPIC_API_KEY не задан — LLM в стаб-режиме");
    else if (this.baseUrl) log.info("LLM через шлюз", { baseUrl: this.baseUrl });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.live) return stub(req);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.callReal(req);
      } catch (e) {
        lastErr = e;
        const wait = backoffMs(attempt);
        log.warn("LLM-вызов не удался, ретрай", { attempt, waitMs: wait });
        await sleep(wait);
      }
    }
    log.error("LLM недоступен после ретраев — стаб", {
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    return stub(req);
  }

  private async callReal(req: LlmRequest): Promise<LlmResponse> {
    const client = (await this.getClient()) as {
      messages: { create(args: unknown, opts?: unknown): Promise<RawResponse> };
    };

    // §15: первый системный блок — кеш-брейкпоинт (кеширует tools+персону, т.к.
    // в каноническом порядке tools идут перед system). TTL — из конфига.
    // cachePrefix=false (разовая команда вне сессии) → тощий префикс без кеша,
    // чтобы не платить 1.25× за перезапись впустую (§15).
    const cacheControl =
      this.cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    const staticBlock =
      req.cachePrefix === false
        ? { type: "text", text: req.systemStatic }
        : { type: "text", text: req.systemStatic, cache_control: cacheControl };
    const system = [
      staticBlock,
      ...(req.systemDynamic ? [{ type: "text", text: req.systemDynamic }] : []),
    ];

    const args = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      // ВНИМАНИЕ: НЕ слать temperature/top_p/top_k. На Opus 4.8 / 4.7 / Fable 5 эти
      // sampling-параметры УДАЛЕНЫ — любой из них → HTTP 400 (invalid_request_error)
      // → стаб «Модель не подключена». (Гейт oneprovider их глотал, реальный Anthropic — нет.)
      // Поведение модели рулим персоной (§11), не temperature.
      system,
      // Блоки messages могут нести cache_control (брейкпоинт растущего диалога
      // в agent-loop, §15) — пробрасываем как есть.
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema,
            })),
          }
        : {}),
    };

    // Extended-cache 1h требует beta-заголовка.
    const opts =
      this.cacheTtl === "1h"
        ? { headers: { "anthropic-beta": "extended-cache-ttl-2025-04-11" } }
        : undefined;

    const resp = await client.messages.create(args, opts);
    return parseResponse(resp);
  }

  private getClient(): Promise<unknown> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const spec = "@anthropic-ai/sdk";
      const mod = await import(spec);
      const Anthropic = (mod.default ?? (mod as { Anthropic?: unknown }).Anthropic) as new (
        opts: { apiKey: string; baseURL?: string; maxRetries?: number; timeout?: number },
      ) => unknown;
      return new Anthropic({
        apiKey: this.apiKey!,
        // Ретраи делаем сами (короткие). Внутренние ретраи SDK (дефолт 2) умножали
        // задержку на дохлом шлюзе → отключаем. timeout — не висеть бесконечно (голос).
        maxRetries: 0,
        timeout: 10_000,
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
      });
    })();
    return this.clientPromise;
  }
}

/** Разобрать ответ SDK в LlmResponse (чистая функция — тестируется отдельно). */
export function parseResponse(resp: RawResponse): LlmResponse {
  const toolUses: ToolUse[] = [];
  let text = "";
  for (const b of resp.content ?? []) {
    if (b.type === "text" && b.text) text += b.text;
    else if (b.type === "tool_use" && b.id && b.name) {
      toolUses.push({ id: b.id, name: b.name, input: b.input ?? {} });
    }
  }
  const stopReason: StopReason =
    resp.stop_reason === "tool_use"
      ? "tool_use"
      : resp.stop_reason === "max_tokens"
        ? "max_tokens"
        : "end_turn";
  return {
    text,
    toolUses,
    stopReason,
    usage: {
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
      cacheReadTokens: resp.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: resp.usage?.cache_creation_input_tokens ?? 0,
    },
    stubbed: false,
  };
}

/** Стаб без сети (нет ключа / шлюз недоступен): короткое произносимое сообщение, без tool-use. */
function stub(_req: LlmRequest): LlmResponse {
  return {
    // Уходит в TTS → чисто и в характере, без debug-префикса и эха запроса.
    text: "Связь с сервером прервалась, сэр. Повторите, пожалуйста.",
    toolUses: [],
    stopReason: "stub",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stubbed: true,
  };
}

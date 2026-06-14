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
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicLlmProvider implements ILlmProvider {
  readonly live: boolean;
  private readonly apiKey: string | undefined;
  private readonly maxRetries: number;
  private clientPromise: Promise<unknown> | null = null;

  constructor(cfg: AnthropicConfig) {
    this.apiKey = cfg.apiKey;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.live = Boolean(cfg.apiKey);
    if (!this.live) log.warn("ANTHROPIC_API_KEY не задан — LLM в стаб-режиме");
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
      messages: { create(args: unknown): Promise<RawResponse> };
    };

    // §15: первый системный блок — кешируемый.
    const system = [
      { type: "text", text: req.systemStatic, cache_control: { type: "ephemeral" } },
      ...(req.systemDynamic ? [{ type: "text", text: req.systemDynamic }] : []),
    ];

    const resp = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.4,
      system,
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
    });

    return parseResponse(resp);
  }

  private getClient(): Promise<unknown> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const spec = "@anthropic-ai/sdk";
      const mod = await import(spec);
      const Anthropic = (mod.default ?? (mod as { Anthropic?: unknown }).Anthropic) as new (
        opts: { apiKey: string },
      ) => unknown;
      return new Anthropic({ apiKey: this.apiKey! });
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
    },
    stubbed: false,
  };
}

/** Детерминированный стаб без сети: отвечает текстом, без tool-use. */
function stub(req: LlmRequest): LlmResponse {
  const last = req.messages.at(-1)?.content;
  const lastText = typeof last === "string" ? last : summarizeBlocks(last ?? []);
  return {
    text: `(стаб LLM, тир ${req.tier}) Модель не подключена. Запрос: «${lastText.slice(0, 80)}».`,
    toolUses: [],
    stopReason: "stub",
    usage: { inputTokens: 0, outputTokens: 0 },
    stubbed: true,
  };
}

function summarizeBlocks(blocks: LlmContentBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
    .join(" ")
    .trim();
}

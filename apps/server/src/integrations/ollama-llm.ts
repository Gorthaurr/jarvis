/** Локальная модель: только loopback Ollama, без облачного fallback и API-ключей. */
import { randomUUID } from "node:crypto";
import type { ILlmProvider, LlmDelta, LlmRequest, LlmResponse } from "./llm.js";
import { ollamaMessages } from "./ollama-messages.js";

export class OllamaLlmProvider implements ILlmProvider {
  readonly live = true;
  private active = new Map<string, AbortController>();
  private url: string;
  channelStatus() { return { primary: "off" as const, subscriptionLive: false, activeProvider: `локальный Ollama (${this.model})` }; }
  constructor(private model = process.env.OLLAMA_MODEL || "qwen3.5:9b-q4_K_M",
    url = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434", private fetcher: typeof fetch = fetch,
    private context = Number(process.env.OLLAMA_CONTEXT || 131_072)) {
    if (!Number.isInteger(context) || context < 4096 || context > 262_144) throw new Error("Ollama: OLLAMA_CONTEXT должен быть от 4096 до 262144");
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password) {
      throw new Error("Ollama: разрешён только локальный HTTP endpoint без credentials");
    }
    this.url = new URL("/api/chat", parsed).href;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const key = req.sessionKey ?? randomUUID();
    if (this.active.has(key)) throw new Error("Ollama: задача уже запрашивает модель");
    const controller = new AbortController(); this.active.set(key, controller);
    try {
      const messages = ollamaMessages(req);
      const tools = (req.tools ?? []).map((t) => ({ type: "function", function: {
        name: t.name, description: t.description, parameters: t.input_schema } }));
      // Консервативная оценка для русского текста. Не позволяем Ollama молча вырезать начало истории.
      const textSize = JSON.stringify({ messages: messages.map(({ images, ...m }) => m), tools }).length;
      const imageCount = messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
      const maxTokens = Math.min(req.maxTokens ?? 2048, 4096);
      if (Math.ceil(textSize / 2) + imageCount * 2048 + maxTokens > this.context) {
        throw new Error("Ollama: история слишком большая для локального контекста; сократите задачу или выберите Codex");
      }
      const response = await this.fetcher(this.url, { method: "POST", redirect: "error",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        body: JSON.stringify({ model: this.model, messages, tools, stream: false, think: false,
          options: { num_ctx: this.context, num_predict: maxTokens, temperature: req.temperature ?? 0.2 } }),
      });
      if (!response.ok) throw new Error(`Ollama: HTTP ${response.status}; проверьте сервер и ollama pull ${this.model}`);
      const data = await response.json() as any;
      if (data.error || !data.done || !data.message) throw new Error(`Ollama: ${data.error || "неполный ответ"}`);
      const toolUses = (data.message.tool_calls ?? []).map((call: any) => {
        const input = call.function?.arguments;
        if (!call.function?.name || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("Ollama: неверный tool_call");
        return { id: call.id || randomUUID(), name: call.function.name, input };
      });
      return { text: data.message.content ?? "", toolUses,
        stopReason: toolUses.length ? "tool_use" : data.done_reason === "length" ? "max_tokens" : "end_turn",
        usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stubbed: false, channel: "local", modelUsed: data.model ?? this.model };
    } finally { this.active.delete(key); }
  }
  async completeStream(req: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
    const response = await this.complete(req);
    if (response.text) onDelta({ text: response.text });
    return response;
  }
  release(key: string): void { this.active.get(key)?.abort(); }
  dispose(): void { for (const controller of this.active.values()) controller.abort(); }
}

/**
 * Локальный LLM через Ollama (§7) — мозг Джарвиса на машине пользователя.
 *
 * Поддерживает TOOL-USE (function calling): qwen2.5/qwen3 умеют вызывать инструменты,
 * поэтому локальный мозг РЕАЛЬНО управляет ПК (app_launch/browser_open/input_type/...),
 * а не только болтает. В отличие от внешних шлюзов (навязывают «Kiro», игнорят промпт)
 * — локальная instruct-модель честно слушается персоны. Reasoning-модели (deepseek-r1)
 * дают <think>…</think> — вырезаем. Бесплатно, приватно, на GPU (RTX).
 */
import { type Logger, backoffMs, createLogger, sleep } from "@jarvis/shared";
import type { ILlmProvider, LlmRequest, LlmResponse, ToolUse } from "./llm.js";

const log: Logger = createLogger("llm:ollama");

export interface OllamaConfig {
  model?: string;
  url?: string;
  maxRetries?: number;
}

/** Вырезать reasoning-блоки <think>…</think> (deepseek-r1 и т.п.) — в голос не нужны. */
function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

/**
 * Конвертировать диалог agent-loop в формат Ollama /api/chat. Важно для tool-use:
 * tool_use ассистента → assistant.tool_calls; tool_result → отдельные сообщения role:"tool",
 * чтобы модель видела результат своего вызова и продолжала корректно (§7).
 */
function toOllamaMessages(req: LlmRequest): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  const system = [req.systemStatic, req.systemDynamic].filter(Boolean).join("\n\n");
  if (system) out.push({ role: "system", content: system });

  for (const m of req.messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text: string[] = [];
    const toolCalls: NonNullable<OllamaMessage["tool_calls"]> = [];
    const toolResults: string[] = [];
    for (const b of m.content) {
      if (b.type === "text") text.push(b.text);
      else if (b.type === "tool_use") toolCalls.push({ function: { name: b.name, arguments: b.input } });
      else if (b.type === "tool_result")
        toolResults.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
    }
    if (m.role === "assistant") {
      const msg: OllamaMessage = { role: "assistant", content: text.join(" ") };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      for (const tr of toolResults) out.push({ role: "tool", content: tr });
      if (text.length) out.push({ role: "user", content: text.join(" ") });
    }
  }
  return out;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaLlmProvider implements ILlmProvider {
  readonly live = true;
  private readonly model: string;
  private readonly url: string;
  private readonly maxRetries: number;

  constructor(cfg: OllamaConfig = {}) {
    this.model = cfg.model ?? "qwen2.5:7b-instruct";
    this.url = (cfg.url ?? "http://localhost:11434").replace(/\/$/, "");
    this.maxRetries = cfg.maxRetries ?? 1;
    log.info("LLM: локальный Ollama (с tool-use)", { model: this.model, url: this.url });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const messages = toOllamaMessages(req);
    // Инструменты в формате Ollama (OpenAI-совместимый function calling).
    const tools = (req.tools ?? []).map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const resp = await fetch(`${this.url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages,
            ...(tools.length ? { tools } : {}),
            stream: false,
            // Низкая temperature — меньше «творческих» срывов на английский/китайский.
            options: { temperature: req.temperature ?? 0.2, num_predict: req.maxTokens ?? 512 },
          }),
        });
        if (!resp.ok) throw new Error(`ollama HTTP ${resp.status}`);
        const data = (await resp.json()) as OllamaChatResponse;

        const calls = data.message?.tool_calls ?? [];
        const toolUses: ToolUse[] = calls
          .filter((c) => c.function?.name)
          .map((c, i) => ({
            id: `ollama-${Date.now().toString(36)}-${i}`,
            name: c.function!.name as string,
            input: c.function!.arguments ?? {},
          }));
        const text = stripThink(data.message?.content ?? "");
        if (toolUses.length) log.info("Ollama tool-use", { tools: toolUses.map((t) => t.name) });

        return {
          text: toolUses.length ? text : text || "Слушаю, сэр.",
          toolUses,
          stopReason: toolUses.length ? "tool_use" : "end_turn",
          usage: {
            inputTokens: data.prompt_eval_count ?? 0,
            outputTokens: data.eval_count ?? 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          stubbed: false,
        };
      } catch (e) {
        lastErr = e;
        log.warn("Ollama-вызов не удался, ретрай", { attempt });
        await sleep(backoffMs(attempt));
      }
    }
    log.error("Ollama недоступен", {
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    return {
      text: "Локальная модель недоступна, сэр. Проверьте, запущен ли Ollama.",
      toolUses: [],
      stopReason: "stub",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stubbed: true,
    };
  }
}

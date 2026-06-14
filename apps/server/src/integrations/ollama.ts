/**
 * Локальный LLM через Ollama (§7) — мозг Джарвиса на машине пользователя.
 *
 * Реализует ILlmProvider. В отличие от внешних шлюзов (которые могут навязывать
 * свою личность и игнорировать системный промпт), локальная instruct-модель
 * честно слушается персоны (§11) — Джарвис остаётся Джарвисом. Бесплатно, приватно,
 * на GPU (RTX). Reasoning-модели (deepseek-r1) дают <think>…</think> — вырезаем.
 *
 * v1 — текстовые ответы без tool-use (управление компом подключим отдельно).
 */
import { type Logger, backoffMs, createLogger, sleep } from "@jarvis/shared";
import type { ILlmProvider, LlmContentBlock, LlmRequest, LlmResponse } from "./llm.js";

const log: Logger = createLogger("llm:ollama");

export interface OllamaConfig {
  model?: string;
  url?: string;
  maxRetries?: number;
}

/** Вырезать reasoning-блоки <think>…</think> (deepseek-r1 и т.п.) — в голос они не нужны. */
function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Свести content (строка или блоки) к тексту для Ollama. */
function flatten(content: string | LlmContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
    .join(" ")
    .trim();
}

interface OllamaChatResponse {
  message?: { content?: string };
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
    log.info("LLM: локальный Ollama", { model: this.model, url: this.url });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const system = [req.systemStatic, req.systemDynamic].filter(Boolean).join("\n\n");
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...req.messages.map((m) => ({ role: m.role, content: flatten(m.content) })),
    ];

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const resp = await fetch(`${this.url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages,
            stream: false,
            options: { temperature: req.temperature ?? 0.4, num_predict: req.maxTokens ?? 512 },
          }),
        });
        if (!resp.ok) throw new Error(`ollama HTTP ${resp.status}`);
        const data = (await resp.json()) as OllamaChatResponse;
        const text = stripThink(data.message?.content ?? "") || "Слушаю, сэр.";
        return {
          text,
          toolUses: [],
          stopReason: "end_turn",
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

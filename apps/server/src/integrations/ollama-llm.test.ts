import { describe, expect, it, vi } from "vitest";
import { OllamaLlmProvider } from "./ollama-llm.js";
import { createNoApiLlm } from "./no-api-llm.js";
import { chargedCostUsd, usageChannel } from "../obs/pricing.js";
import type { LlmRequest } from "./llm.js";
const req: LlmRequest = { model: "claude", tier: "sonnet", systemStatic: "Jarvis", messages: [
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "x" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "denied" }] },
] };
describe("local LLM", () => {
  it("передаёт tool error, считает канал local и нулевой API-расход", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ done: true, model: "local-model", message: { content: "Не получилось" }, prompt_eval_count: 100, eval_count: 20 })));
    const p = new OllamaLlmProvider("local-model", "http://127.0.0.1:11434", fetcher as typeof fetch);
    const response = await p.complete(req);
    const body = JSON.parse((fetcher.mock.calls[0] as any)[1].body);
    expect(body.messages.at(-1)).toMatchObject({ role: "tool", tool_name: "read", tool_call_id: "t1", content: "[ОШИБКА ИНСТРУМЕНТА]\ndenied" });
    expect(body.think).toBe(false); expect(response.stubbed).toBe(false);
    expect(chargedCostUsd(response, "local-model")).toBe(0); expect(usageChannel(response)).toBe("local");
  });
  it("не подменяет ошибку сервера успешным пустым ответом", async () => {
    const p = new OllamaLlmProvider("m", "http://127.0.0.1:1", vi.fn(async () => new Response('{"error":"out of memory"}')) as typeof fetch);
    await expect(p.complete(req)).rejects.toThrow("out of memory");
  });
  it("отклоняет удалённые endpoints, слишком большой контекст и продуктовый режим", async () => {
    expect(() => new OllamaLlmProvider("m", "https://ollama.com")).toThrow("локальный");
    expect(() => createNoApiLlm(true, "codex")).toThrow("личного");
    expect(() => createNoApiLlm(false, "typo")).toThrow("Неизвестный");
    const fetcher = vi.fn(); const p = new OllamaLlmProvider("m", "http://127.0.0.1:1", fetcher, 4096);
    await expect(p.complete({ ...req, systemStatic: "а".repeat(9000) })).rejects.toThrow("контекста"); expect(fetcher).not.toHaveBeenCalled();
  });
});

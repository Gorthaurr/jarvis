/** Явный выбор мозга. Ошибка провайдера не включает платный API автоматически. */
import type { ILlmProvider } from "./llm.js";
import { CodexLlmProvider } from "./codex-llm.js";
import { OllamaLlmProvider } from "./ollama-llm.js";

export function createNoApiLlm(product: boolean, mode = process.env.LLM_PROVIDER ?? "claude"): ILlmProvider | undefined {
  if (mode === "claude") return undefined;
  if (mode !== "codex" && mode !== "local") throw new Error(`Неизвестный LLM_PROVIDER: ${mode}; допустимы claude, codex, local`);
  if (product) throw new Error("LLM_PROVIDER codex/local пока доступны только для личного Jarvis, не для продуктового режима");
  return mode === "codex" ? new CodexLlmProvider() : new OllamaLlmProvider();
}

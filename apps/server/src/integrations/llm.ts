/**
 * Контракт LLM-провайдера с поддержкой tool-use (§7, §8, §15).
 *
 * Абстрагирует тир/модель и инструменты. Реальная реализация — anthropic.ts;
 * MockLlmProvider (здесь) скриптует ответы для тестов agent-loop без сети.
 *
 * Сообщения поддерживают блоки (text/tool_use/tool_result) — иначе agent-loop
 * с вызовом инструментов не выразить.
 */
import type { Tier } from "@jarvis/shared";
import type { ToolSchema } from "@jarvis/tools";

export type LlmContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | LlmContentBlock[];
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmRequest {
  tier: Tier;
  /** id модели тира (разрешён вызывающим из config.models). */
  model: string;
  /** Кешируемый системный префикс (персона, §15). */
  systemStatic: string;
  /** Динамический хвост системы (контекст юзера). */
  systemDynamic?: string;
  messages: LlmMessage[];
  /** Доступные инструменты (§6, §12) в формате Anthropic tool-use. */
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stub";

export interface LlmResponse {
  /** Сводный текст ответа (конкатенация text-блоков). */
  text: string;
  /** Запрошенные моделью вызовы инструментов (если stopReason==="tool_use"). */
  toolUses: ToolUse[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
  /** true — ответ синтезирован стабом/моком (без реального вызова). */
  stubbed: boolean;
}

export interface ILlmProvider {
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** Доступен ли реальный бэкенд (есть ключ и SDK). */
  readonly live: boolean;
}

/** Один скриптованный ход mock-модели. */
export interface MockTurn {
  text?: string;
  toolUses?: ToolUse[];
}

/**
 * Mock LLM: отдаёт заранее заданную последовательность ходов. Позволяет в тестах
 * прогнать полный agent-loop: ход 1 запрашивает инструмент, ход 2 — финальный текст.
 * Записывает все полученные запросы для ассертов.
 */
export class MockLlmProvider implements ILlmProvider {
  readonly live = false;
  readonly requests: LlmRequest[] = [];
  private i = 0;

  constructor(private readonly script: MockTurn[] = []) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const turn = this.script[this.i] ?? { text: "Готово." };
    this.i += 1;
    const toolUses = turn.toolUses ?? [];
    return {
      text: turn.text ?? "",
      toolUses,
      stopReason: toolUses.length > 0 ? "tool_use" : "end_turn",
      usage: { inputTokens: 12, outputTokens: 8 },
      stubbed: true,
    };
  }
}

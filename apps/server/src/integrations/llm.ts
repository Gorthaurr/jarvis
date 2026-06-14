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

/** Маркер кеш-брейкпоинта (§15): помечает конец кешируемого префикса. */
export interface CacheControl {
  type: "ephemeral";
  /** TTL кеша; "5m" (дефолт) или "1h" (extended, требует beta-заголовок). */
  ttl?: "5m" | "1h";
}

export type LlmContentBlock =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; cache_control?: CacheControl };

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
  /**
   * Кешировать ли статичный префикс (§15). Дефолт true. false — «тощий префикс»
   * для разовой команды вне активной сессии (не платить 1.25× за перезапись впустую).
   */
  cachePrefix?: boolean;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stub";

export interface LlmResponse {
  /** Сводный текст ответа (конкатенация text-блоков). */
  text: string;
  /** Запрошенные моделью вызовы инструментов (если stopReason==="tool_use"). */
  toolUses: ToolUse[];
  stopReason: StopReason;
  /**
   * Токены. cacheReadTokens/cacheCreationTokens — метрики prompt-кеша (§15):
   * read = прочитано из кеша (дёшево), creation = записано в кеш (дороже на 25%).
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
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
      usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stubbed: true,
    };
  }
}

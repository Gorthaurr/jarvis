/**
 * Контракт LLM-провайдера с поддержкой tool-use (§7, §8, §15).
 *
 * Абстрагирует тир/модель и инструменты. Реальная реализация — anthropic.ts;
 * MockLlmProvider (здесь) скриптует ответы для тестов agent-loop без сети.
 *
 * Сообщения поддерживают блоки (text/tool_use/tool_result) — иначе agent-loop
 * с вызовом инструментов не выразить.
 */
import type { ThinkingEffort, Tier } from "@jarvis/shared";
import type { ToolSchema } from "@jarvis/tools";

/** Маркер кеш-брейкпоинта (§15): помечает конец кешируемого префикса. */
export interface CacheControl {
  type: "ephemeral";
  /** TTL кеша; "5m" (дефолт) или "1h" (extended, требует beta-заголовок). */
  ttl?: "5m" | "1h";
}

/** Блок изображения (§ зрение): base64-картинка для vision-модели (скрин экрана и т.п.). */
export interface ImageSource {
  type: "base64";
  media_type: string;
  data: string;
}
/** Содержимое tool_result: текст и/или картинки (Anthropic допускает массив блоков). */
export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource };

export type LlmContentBlock =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | { type: "image"; source: ImageSource }
  // Блоки размышления (extended thinking). При thinking+tool-use Anthropic ТРЕБУЕТ вернуть их в
  // assistant-ходе СЛЕДУЮЩЕГО запроса (с подписью) — иначе 400. Поэтому несём их в истории как есть.
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      // Строка ИЛИ массив блоков (текст+картинки) — для зрения (look_at_screen возвращает скрин).
      content: string | ToolResultContent[];
      is_error?: boolean;
      cache_control?: CacheControl;
    };

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
  /**
   * Кешируемый блок выученного навыка (§8 HERMES). Отдельный кеш-брейкпоинт ПОСЛЕ персоны:
   * пока навык тот же (многоходовая задача / повторное применение), он читается из кеша
   * (cache_read ~0.1×), а не переотправляется полным текстом каждый ход. Пусто — блока нет.
   */
  systemSkill?: string;
  /**
   * §15 ленивая загрузка: КАТАЛОГ холодных/внешних инструментов (однострочники) — отдельный кешируемый
   * блок ПОСЛЕ персоны. Меняется редко (tool_load/подключение MCP), а не каждый ход → почти всегда
   * cache_read. Полные схемы холодных в `tools` не шлём — экономим префикс. Пусто — блока нет.
   */
  systemTools?: string;
  /** Динамический хвост системы (контекст юзера) — НЕ кешируется (меняется по ходам). */
  systemDynamic?: string;
  messages: LlmMessage[];
  /** Доступные инструменты (§6, §12) в формате Anthropic tool-use. */
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  /** «Эффорт» рассуждения (§7): off|adaptive|число-бюджет → параметр thinking Anthropic (модель-aware). */
  thinking?: ThinkingEffort;
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
  /**
   * Блоки размышления (extended thinking), как пришли от API (с подписью). Если непусто — agent-loop
   * ОБЯЗАН вернуть их ПЕРВЫМИ в assistant-ходе при следующем запросе с tool_use (требование Anthropic).
   */
  thinkingBlocks?: LlmContentBlock[];
}

/** Текстовая дельта стрима генерации (§10 realtime token-streaming). */
export interface LlmDelta {
  text: string;
}

export interface ILlmProvider {
  complete(req: LlmRequest): Promise<LlmResponse>;
  /**
   * Стриминговый вариант complete (§10 realtime): текстовые дельты идут в onDelta по мере
   * генерации, метод резолвится финальным LlmResponse (toolUses/stopReason/usage — как у
   * complete). На tool-ходе текстовый префикс обычно пуст; вызывающий по resp.toolUses
   * откатывается на штатный мульти-шаг. Реализация ГАРАНТИРУЕТ: суммарный onDelta-текст
   * соответствует resp.text при stopReason==="end_turn" (иначе двойной голос в пайплайне).
   */
  completeStream(req: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse>;
  /** Доступен ли реальный бэкенд (есть ключ и SDK). */
  readonly live: boolean;
}

/** Один скриптованный ход mock-модели. */
export interface MockTurn {
  text?: string;
  toolUses?: ToolUse[];
  /** Переопределить stop_reason (для тестов докрутки max_tokens и т.п.). */
  stopReason?: StopReason;
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
      stopReason: turn.stopReason ?? (toolUses.length > 0 ? "tool_use" : "end_turn"),
      usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stubbed: true,
    };
  }

  completeStream(req: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
    return streamViaComplete(this, req, onDelta);
  }
}

/**
 * Реализация completeStream поверх complete для не-стримящих провайдеров (моки/тесты):
 * вызывает complete, затем отдаёт текст дельтами по словам, сохраняя инвариант
 * «сумма дельт === resp.text». Реальный стрим (anthropic.ts) свой — этот не использует.
 */
export async function streamViaComplete(
  provider: Pick<ILlmProvider, "complete">,
  req: LlmRequest,
  onDelta: (d: LlmDelta) => void,
): Promise<LlmResponse> {
  const resp = await provider.complete(req);
  if (resp.text) for (const piece of chunkWords(resp.text)) onDelta({ text: piece });
  return resp;
}

/** Разбить текст на «дельты» по словам (с пробелами), сохраняя точную конкатенацию. */
function chunkWords(text: string): string[] {
  const parts = text.match(/\S+\s*/g);
  return parts ?? [text];
}

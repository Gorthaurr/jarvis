/**
 * Волна C (P1 «hard-порог контекста убивает задачу»): СВЁРТКА старых ПЕРЕЧИТЫВАЕМЫХ наблюдений
 * вместо смерти задачи на пороге контекст-окна.
 *
 * Было: проекция промпта дошла до `CONTEXT_HARD_TOKENS` → петля честно, но БЕЗВОЗВРАТНО сворачивалась
 * («задача разрослась и перестала помещаться в память»). Вся проделанная работа — в мусор, хотя 80%
 * веса промпта к этому моменту составляют СТАРЫЕ дампы (web_fetch/browser_read/OCR/ui_snapshot),
 * которые модель уже прочитала и которые в любой момент можно ПЕРЕЧИТАТЬ инструментом.
 *
 * Стало: перед тем как убить задачу, освобождаем место — старые наблюдения заменяются ЧЕСТНОЙ
 * заглушкой («содержимое не сохранено, перечитай инструментом»). Убить задачу — по-прежнему можно,
 * но только если свернуть уже нечего.
 *
 * Законы, которые здесь соблюдаются (см. CLAUDE.md):
 *  • ЧЕСТНОСТЬ. Заглушка НЕ притворяется данными и прямо запрещает «помнить» содержимое: модель
 *    обязана перечитать инструментом. Молчаливое выбрасывание (как делает autoCompact) запрещено —
 *    оно порождает ложный успех «я же видел, там было…».
 *  • НЕ ТРОГАЕМ РЕЗУЛЬТАТЫ ДЕЙСТВИЙ. Сворачиваются только `verify`/`neutral` инструменты (чтения и
 *    сверки — перечитываемы). Результат `mutate` (code_run stdout, fs_write, отправка) — ЕДИНСТВЕННАЯ
 *    запись о том, что было СДЕЛАНО: его свёртка = потеря памяти о своих действиях.
 *  • НЕ ТРОГАЕМ СВЕЖЕЕ. Последние `keepRecent` раундов с наблюдениями — актуальное состояние экрана/
 *    страницы, на них модель опирается прямо сейчас (в т.ч. снимает verify-долг).
 *
 * Кеш (§15): мутация истории ломает prompt-кеш с позиции самого раннего свёрнутого блока — это
 * ОДНА перезапись префикса против потери всей задачи. Вызывающий логирует причину (WARN 1.8).
 *
 * Чистая функция без зависимостей от петли — мутирует convo на месте, возвращает статистику.
 */
import type { LlmContentBlock, LlmMessage, ToolResultContent } from "../../integrations/llm.js";
import { toolEffect } from "./error-voice.js";

/** Блок результата инструмента (сужение union'а LlmContentBlock). */
type ToolResultBlock = Extract<LlmContentBlock, { type: "tool_result" }>;

/** Параметры свёртки. Все — с безопасными дефолтами; вызывающий задаёт только цель по объёму. */
export interface MaskOptions {
  /**
   * Сколько ПОСЛЕДНИХ сообщений с результатами инструментов не трогать (свежие наблюдения = текущее
   * состояние мира, на них опирается ближайший ход и сверка слепого действия). Деф 2.
   */
  keepRecent?: number;
  /**
   * Минимальный размер наблюдения (символов), ниже которого сворачивать не стоит: экономия меньше,
   * чем цена перезаписи кеш-префикса. Деф 1200.
   */
  minChars?: number;
  /**
   * Сколько символов нужно освободить. Достигли — останавливаемся (не курочим историю сверх нужды).
   * 0/undefined — сворачиваем всё, что можно (агрессивный режим для чекпойнта).
   */
  targetChars?: number;
  /**
   * Политика «этот инструмент перечитываем?». По умолчанию — `toolEffect` по имени: verify/neutral
   * перечитываемы, mutate — нет. Петля передаёт свою версию, учитывающую ДЕКЛАРАЦИЮ MCP-сервера
   * (mcp.json): эвристика по имени не знает, что `get_*` внешнего сервера может быть мутирующим.
   */
  isRefetchable?: (toolName: string) => boolean;
}

/** Статистика свёртки: сколько блоков свёрнуто и сколько символов освобождено. */
export interface MaskResult {
  masked: number;
  freedChars: number;
}

/** Перечитываемо ли наблюдение этого инструмента (см. law «не трогаем результаты действий»). */
export function isRefetchableTool(name: string): boolean {
  const effect = toolEffect(name);
  return effect === "verify" || effect === "neutral";
}

/**
 * Честная заглушка на месте свёрнутого наблюдения. Формулировка намеренно ЗАПРЕЩАЕТ полагаться на
 * память: без этого модель «вспоминала» вычищенный дамп и выдавала догадку за прочитанное.
 */
function stubFor(toolName: string, chars: number): Extract<ToolResultContent, { type: "text" }> {
  return {
    type: "text",
    text:
      `[наблюдение свёрнуто ради места в контексте: ${toolName}, было ~${chars} симв. ` +
      `Содержимое НЕ сохранено — если оно нужно, ПЕРЕЧИТАЙ инструментом заново и не выдавай память за прочитанное.]`,
  };
}

/**
 * Один свёртываемый кандидат. Две формы, потому что Anthropic допускает у tool_result и строку, и
 * массив блоков. ⚠️ Мутация откладывается до момента реальной свёртки: превращать строку в массив
 * «на всякий случай» нельзя — это переписывает уже закешированную историю без всякой выгоды.
 */
type Candidate =
  | { form: "string"; block: ToolResultBlock; toolName: string; chars: number }
  | { form: "array"; blocks: ToolResultContent[]; idx: number; toolName: string; chars: number };

/**
 * Свернуть СТАРЫЕ перечитываемые наблюдения в convo, освободив не менее `targetChars` символов.
 *
 * Идёт от САМЫХ СТАРЫХ к свежим (старое — дешевле терять и дальше от хвоста, значит меньше урон
 * кешу оставшегося префикса). Останавливается, как только цель достигнута.
 */
export function maskOldObservations(convo: LlmMessage[], opts: MaskOptions = {}): MaskResult {
  const keepRecent = Math.max(0, opts.keepRecent ?? 2);
  const minChars = Math.max(1, opts.minChars ?? 1200);
  const target = Math.max(0, opts.targetChars ?? 0);
  const refetchable = opts.isRefetchable ?? isRefetchableTool;

  // tool_use_id → имя инструмента: сам tool_result имени не несёт, а политика свёртки — по инструменту.
  const nameById = new Map<string, string>();
  for (const msg of convo) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") nameById.set(block.id, block.name);
    }
  }

  // Индексы сообщений, несущих tool_result (по ним считается «свежесть» раунда).
  const resultMsgIdx: number[] = [];
  for (let i = 0; i < convo.length; i += 1) {
    const msg = convo[i]!;
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    if (msg.content.some((b) => b.type === "tool_result")) resultMsgIdx.push(i);
  }
  // Свежие раунды неприкосновенны: их наблюдения — актуальное состояние мира.
  const protectedFrom = resultMsgIdx.length > keepRecent ? resultMsgIdx[resultMsgIdx.length - keepRecent] : undefined;
  const cutoff = keepRecent === 0 ? Number.POSITIVE_INFINITY : (protectedFrom ?? -1);

  const candidates: Candidate[] = [];
  for (let i = 0; i < convo.length; i += 1) {
    if (i >= cutoff) break; // дальше — защищённый хвост
    const msg = convo[i]!;
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      const toolName = nameById.get(block.tool_use_id);
      // Имя неизвестно (осиротевший результат/усечённая история) — консервативно НЕ трогаем: не знаем,
      // было ли это действие или чтение.
      if (!toolName || !refetchable(toolName)) continue;
      if (typeof block.content === "string") {
        const chars = block.content.length;
        if (chars < minChars) continue;
        candidates.push({ form: "string", block, toolName, chars });
        continue;
      }
      for (let k = 0; k < block.content.length; k += 1) {
        const inner = block.content[k]!;
        if (inner.type !== "text") continue; // картинки — забота pruneStaleImages (у неё своя политика)
        const chars = inner.text.length;
        if (chars < minChars) continue;
        candidates.push({ form: "array", blocks: block.content, idx: k, toolName, chars });
      }
    }
  }

  let masked = 0;
  let freedChars = 0;
  for (const c of candidates) {
    if (target > 0 && freedChars >= target) break;
    const stub = stubFor(c.toolName, c.chars);
    const saved = c.chars - stub.text.length;
    if (saved <= 0) continue; // заглушка не короче оригинала — смысла нет (историю зря не трогаем)
    if (c.form === "string") c.block.content = [stub];
    else c.blocks[c.idx] = stub;
    masked += 1;
    freedChars += saved;
  }
  return { masked, freedChars };
}

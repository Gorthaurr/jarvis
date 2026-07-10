/**
 * §скорость (зрение): вырезка УСТАРЕВШИХ скриншотов из convo агент-петли.
 *
 * Каждый screen_capture ≈ 2K токенов и живёт в истории до конца задачи: к 18-му раунду промпт
 * раздувался до ~44K, и время до первого токена росло с каждым шагом (живой замер «поиск в доте»:
 * ~15с/раунд). Модель по persona v22 и навыкам обязана опираться ТОЛЬКО на СВЕЖИЙ скрин
 * («координаты не из головы»), так что старые кадры — мёртвый груз: держим последние `keep`,
 * остальные заменяем текстовой заглушкой.
 *
 * Кеш (§15): мутация блока в истории ломает prompt-кеш с этого места. Третий-с-конца скрин лежит
 * в ~2 раундах от хвоста → перезапишутся только последние раунды (cache_creation), весь префикс
 * до него остаётся cache_read. Это дешевле и быстрее, чем таскать растущую пачку картинок.
 *
 * Чистая функция без зависимостей от петли — мутирует convo на месте, возвращает число вырезанных.
 */
import type { LlmMessage, ToolResultContent } from "../../integrations/llm.js";

/** Заглушка на месте вырезанного кадра — модель видит, что кадр был, но устарел. */
const STALE_STUB: ToolResultContent = {
  type: "text",
  text: "[скриншот устарел и вырезан из контекста — актуальное состояние экрана смотри в более свежем screen_capture]",
};

/**
 * Оставить в истории только `keep` ПОСЛЕДНИХ изображений (по порядку появления),
 * более старые image-блоки внутри tool_result заменить текстовой заглушкой.
 */
export function pruneStaleImages(convo: LlmMessage[], keep = 2): number {
  const refs: Array<{ blocks: ToolResultContent[]; idx: number }> = [];
  for (const msg of convo) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result" || typeof block.content === "string") continue;
      const blocks = block.content;
      for (let i = 0; i < blocks.length; i += 1) {
        if (blocks[i]!.type === "image") refs.push({ blocks, idx: i });
      }
    }
  }
  const stale = Math.max(0, refs.length - Math.max(0, keep));
  for (let k = 0; k < stale; k += 1) {
    const r = refs[k]!;
    r.blocks[r.idx] = STALE_STUB;
  }
  return stale;
}

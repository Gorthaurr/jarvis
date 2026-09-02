/**
 * §скорость (зрение): вырезка старых image-блоков из convo агент-петли.
 *
 * Каждый screen_capture ≈ 2K токенов и живёт в истории до конца задачи: к 18-му раунду промпт
 * раздувался до ~44K, и время до первого токена росло с каждым шагом (живой замер «поиск в доте»:
 * ~15с/раунд). Модель по persona v22 и навыкам обязана опираться ТОЛЬКО на СВЕЖИЙ скрин
 * («координаты не из головы»), так что старые кадры — мёртвый груз: держим последние `keep`,
 * остальные заменяем текстовой заглушкой.
 *
 * ТРИ КЛАССА картинок (§3.9, попутная правка честности + ревью 2026-09-01): СКРИНШОТ устаревает
 * (экран живёт), СТРАНИЦА ДОКУМЕНТА (file_view) — нет, а ПРОЧЕЕ (картинка MCP-инструмента) — не экран
 * вовсе; подписать документу или MCP-картинке «скриншот устарел — сними свежий screen_capture» значило бы
 * соврать и послать модель не туда. Класс определяется ПОЗИТИВНО по текстовым блокам ТОГО ЖЕ tool_result
 * (image-marks.ts — единый формат с хендлерами). Бюджеты раздельные: `keep` для скриншотов и прочего,
 * `keepDocs` для страниц; заглушка документа честная — «свёрнута для экономии, НЕ устарела» — и называет
 * путь/страницу для повторного file_view.
 *
 * 🔴 ХВОСТ НЕ ТРОГАЕМ (ревью 2026-09-01, HIGH): петля зовёт prune сразу после `convo.push(resultBlocks)`,
 * до отправки модели. Параллельный раунд из трёх file_view (стр. 1–3) при keepDocs=2 резал страницу 1
 * ДО того, как модель её увидела, а заглушка велела «вызови заново» — повтор снова вытеснял соседа.
 * Картинки последнего user-хода (результаты текущего раунда) входят в счёт бюджета, но заглушкой не
 * заменяются — свернутся раундом позже.
 *
 * Кеш (§15): мутация блока в истории ломает prompt-кеш с этого места. Третий-с-конца скрин лежит
 * в ~2 раундах от хвоста → перезапишутся только последние раунды (cache_creation), весь префикс
 * до него остаётся cache_read. Это дешевле и быстрее, чем таскать растущую пачку картинок.
 *
 * Чистая функция без зависимостей от петли — мутирует convo на месте, возвращает число вырезанных.
 */
import type { LlmMessage, ToolResultContent } from "../../integrations/llm.js";
import { type ImageClass, classifyImageBlocks, parseFileViewMark } from "./image-marks.js";

/** Заглушка на месте вырезанного кадра — модель видит, что кадр был, но устарел. */
const STALE_STUB: ToolResultContent = {
  type: "text",
  text: "[скриншот устарел и вырезан из контекста — актуальное состояние экрана смотри в более свежем screen_capture]",
};

/** Картинка НЕ с экрана и НЕ документ (MCP-инструмент): нейтрально, без ложного совета «сними экран». */
const OTHER_STUB: ToolResultContent = {
  type: "text",
  text: "[картинка свёрнута из контекста для экономии — при необходимости получи её заново тем же инструментом]",
};

/** Заглушка страницы документа: НЕ «устарела» — свёрнута ради экономии, повторный file_view вернёт её. */
function docStub(marker: string): ToolResultContent {
  const m = parseFileViewMark(marker);
  const call = m
    ? `file_view{path:${JSON.stringify(m.path)}${m.page !== undefined ? `, page:${m.page}` : ""}}`
    : "file_view{path,page}";
  const where = m ? ` ${m.path}${m.page !== undefined ? `, стр. ${m.page}` : ""}` : "";
  return {
    type: "text",
    text: `[страница документа свёрнута из контекста для экономии — она НЕ устарела; чтобы увидеть снова, вызови ${call} заново:${where}]`,
  };
}

interface ImageRef {
  blocks: ToolResultContent[];
  idx: number;
  /** Первая строка маркерного текст-блока того же tool_result (только у документов). */
  marker?: string;
  /** Результат ТЕКУЩЕГО раунда — модель его ещё не видела, резать нельзя. */
  protectedTail: boolean;
}

/**
 * Оставить в истории только `keep` ПОСЛЕДНИХ скриншотов (и прочих картинок — отдельно) и `keepDocs`
 * ПОСЛЕДНИХ страниц документов (по порядку появления, классы считаются раздельно); более старые
 * image-блоки внутри tool_result заменить текстовой заглушкой своего класса. Картинки последнего
 * user-хода не трогаются (см. шапку).
 */
export function pruneStaleImages(convo: LlmMessage[], keep = 2, keepDocs = 2): number {
  let lastUserIdx = -1;
  for (let i = 0; i < convo.length; i += 1) {
    const m = convo[i]!;
    if (m.role === "user" && typeof m.content !== "string") lastUserIdx = i;
  }
  const byClass: Record<ImageClass, ImageRef[]> = { doc: [], screenshot: [], other: [] };
  convo.forEach((msg, msgIdx) => {
    if (msg.role !== "user" || typeof msg.content === "string") return;
    for (const block of msg.content) {
      if (block.type !== "tool_result" || typeof block.content === "string") continue;
      const blocks = block.content;
      // Класс ищем ТОЛЬКО внутри этого же tool_result — чужой file_view в том же user-ходе не должен
      // «одокументить» соседний скриншот.
      const cls = classifyImageBlocks(blocks);
      const marker =
        cls === "doc"
          ? blocks.find((b): b is Extract<ToolResultContent, { type: "text" }> => b.type === "text" && parseFileViewMark(b.text) !== null)?.text
          : undefined;
      for (let i = 0; i < blocks.length; i += 1) {
        if (blocks[i]!.type !== "image") continue;
        byClass[cls].push({ blocks, idx: i, marker, protectedTail: msgIdx === lastUserIdx });
      }
    }
  });
  let pruned = 0;
  const prune = (refs: ImageRef[], budget: number, stub: (r: ImageRef) => ToolResultContent): void => {
    const stale = Math.max(0, refs.length - Math.max(0, budget));
    for (let k = 0; k < stale; k += 1) {
      const r = refs[k]!;
      if (r.protectedTail) continue; // текущий раунд — модель ещё не видела
      r.blocks[r.idx] = stub(r);
      pruned += 1;
    }
  };
  prune(byClass.screenshot, keep, () => STALE_STUB);
  prune(byClass.other, keep, () => OTHER_STUB);
  prune(byClass.doc, keepDocs, (r) => docStub(r.marker ?? ""));
  return pruned;
}

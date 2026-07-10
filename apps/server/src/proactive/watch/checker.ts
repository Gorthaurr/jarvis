/**
 * РЕАЛЬНЫЙ проверяльщик наблюдения (watch): ограниченный LLM-цикл, который добывает ТЕКУЩЕЕ значение
 * через web_search/web_fetch и решает, выполнено ли условие СЕЙЧАС, возвращая структурный CheckResult.
 *
 * Концепт-выровнен: модель сама водит общими веб-инструментами (не хардкодим источники), а сервис лишь
 * получает {met, value, summary}. Набор инструментов УЗКИЙ (поиск/чтение страницы + report) — никаких
 * действий на устройстве: проверка идёт в фоне, без клиентской сессии. Тир дешёвый (часто повторяется).
 */
import { type Logger, type Tier, createLogger } from "@jarvis/shared";
import type { ToolSchema } from "@jarvis/tools";
import type { ILlmProvider, LlmContentBlock, LlmMessage } from "../../integrations/llm.js";
import type { IWebProvider } from "../../integrations/web.js";
import type { CheckResult, Watch, WatchChecker } from "./watch.js";

const log: Logger = createLogger("watch:checker");

const CHECK_TOOLS: ToolSchema[] = [
  {
    name: "web_search",
    description: "Найти в вебе АКТУАЛЬНЫЕ факты/значения по запросу (курс, цена, новость, статус).",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "web_fetch",
    description: "Прочитать страницу по URL — для точного значения/заголовка/наличия текста.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "report",
    description:
      "Сообщить итог проверки. met=true только если условие ВЫПОЛНЕНО прямо сейчас по фактам. value — наблюдённое значение. summary — короткая фраза владельцу (что произошло + значение), нужна при met=true.",
    input_schema: {
      type: "object",
      properties: { met: { type: "boolean" }, value: { type: "string" }, summary: { type: "string" } },
      required: ["met", "summary"],
    },
  },
];

export interface WatchCheckerDeps {
  llm: ILlmProvider;
  web: IWebProvider;
  /** Модель тира для проверки (дешёвый слот — sonnet; часто повторяется). */
  model: string;
  tier: Tier;
  /** Кап шагов цикла (поиск→report). Деф 4. */
  maxSteps?: number;
}

/** Собрать реальный проверяльщик наблюдения поверх LLM + web. */
export function createWatchChecker(deps: WatchCheckerDeps): WatchChecker {
  const maxSteps = deps.maxSteps ?? 4;
  return async (w: Watch): Promise<CheckResult> => {
    const system =
      `Ты — проверяльщик наблюдения Джарвиса. Определи ТЕКУЩЕЕ фактическое состояние и реши, выполнено ли условие ПРЯМО СЕЙЧАС.\n` +
      `ЧТО отслеживаем: ${w.what}\n` +
      `УСЛОВИЕ уведомления: ${w.condition}\n` +
      (w.lastValue ? `Прошлое наблюдённое значение: ${w.lastValue}\n` : "") +
      `Добудь актуальный факт через web_search/web_fetch — НЕ выдумывай. Затем ОБЯЗАТЕЛЬНО вызови report{met,value,summary}. ` +
      `Если данных нет или они противоречивы — met:false. summary нужен только при met:true (короткая фраза владельцу: что произошло и значение).`;
    const messages: LlmMessage[] = [{ role: "user", content: "Проверь это наблюдение сейчас." }];

    for (let step = 0; step < maxSteps; step += 1) {
      let resp;
      try {
        resp = await deps.llm.complete({ tier: deps.tier, model: deps.model, systemStatic: system, messages, tools: CHECK_TOOLS, cachePrefix: false });
      } catch (e) {
        return { met: false, summary: "", error: e instanceof Error ? e.message : String(e) };
      }
      if (resp.toolUses.length === 0) {
        return { met: false, summary: "", error: "проверяльщик не вызвал report (нет вывода инструмента)" };
      }
      const assistantBlocks: LlmContentBlock[] = [];
      if (resp.text) assistantBlocks.push({ type: "text", text: resp.text });
      for (const tu of resp.toolUses) assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      messages.push({ role: "assistant", content: assistantBlocks });

      const results: LlmContentBlock[] = [];
      let report: CheckResult | null = null;
      for (const tu of resp.toolUses) {
        if (tu.name === "report") {
          report = {
            met: Boolean(tu.input.met),
            value: typeof tu.input.value === "string" ? tu.input.value : undefined,
            summary: String(tu.input.summary ?? "").trim(),
          };
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "принято" });
        } else if (tu.name === "web_search") {
          const hits = await deps.web.search(String(tu.input.query ?? ""), 5).catch(() => []);
          const text = hits.length
            ? hits.map((h, i) => `${i + 1}. ${h.title}\n${h.snippet}\n${h.url}`).join("\n\n")
            : "ничего не найдено";
          results.push({ type: "tool_result", tool_use_id: tu.id, content: text.slice(0, 4000) });
        } else if (tu.name === "web_fetch") {
          const page = await deps.web.fetch(String(tu.input.url ?? "")).catch(() => null);
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: (page ? `${page.title}\n${page.text}` : "не удалось прочитать страницу").slice(0, 4000),
          });
        } else {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "неизвестный инструмент", is_error: true });
        }
      }
      if (report) {
        log.info("проверка наблюдения завершена", { id: w.id, met: report.met });
        return report;
      }
      messages.push({ role: "user", content: results });
    }
    return { met: false, summary: "", error: "проверяльщик: превышен лимит шагов без report" };
  };
}

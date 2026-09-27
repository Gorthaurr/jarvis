/**
 * Когда живую сессию SDK на подписке можно ПРОДОЛЖАТЬ, а когда — начать заново (W2 + W3 L-6).
 *
 * Сессия держит историю задачи в кеше CLI и принимает только хвост — результаты ожидаемых инструментов. Всё, что
 * петля делает с уже отправленной историей, до неё не доходит. 🔴 L-6: у потолка контекста петля сворачивает
 * старые дампы (`mask-observations.ts`), а после каждого GUI-раунда вырезает устаревшие скриншоты
 * (`prune-images.ts`) — и на подписке ни то, ни другое реальный промпт не уменьшало: следующий usage снова
 * приходил у потолка, свёртка повторялась впустую, задача кончалась `contextWrap`. Теперь петля помечает запрос
 * (`LlmRequest.historyRewritten`), и провайдер начинает сессию заново со СВЁРНУТЫМ транскриптом.
 */
import type { LlmRequest } from "./llm.js";
import type { ToolOutcome } from "./subscription-session.js";

/**
 * Сколько картинок терпим в живой сессии после вырезки скринов петлёй. Сброс на КАЖДОЙ вырезке (а она идёт почти
 * каждый GUI-раунд — у петли KEEP_SCREENSHOTS=1) превратил бы каждый раунд в новый CLI (0,6–1,1 с + запись кеша);
 * порог держит мёртвый груз картинок в пределах ~8×2K токенов, а сброс — раз в несколько GUI-раундов.
 */
export const PRUNE_RESET_IMAGES = 8;

/** Сколько картинок уходит в сессию с результатами инструментов (MCP image-блоки). */
export function countOutcomeImages(outcomes: readonly ToolOutcome[]): number {
  let n = 0;
  for (const o of outcomes) if (Array.isArray(o.content)) n += o.content.filter((b) => b.type === "image").length;
  return n;
}

/** Причина начать сессию заново из-за переписанной петлёй истории; undefined — продолжать как есть. */
export function rewriteResetReason(req: LlmRequest, imagesInSession: number): string | undefined {
  if (req.historyRewritten === "masked") return "петля свернула старые наблюдения — продолжаю со свёрнутой историей";
  if (req.historyRewritten === "pruned" && imagesInSession > PRUNE_RESET_IMAGES) {
    return `в сессии ${imagesInSession} картинок, петля вырезала устаревшие — продолжаю с актуальными`;
  }
  return undefined;
}

/** Продолжение сессии: результаты инструментов из хвоста запроса, если он ровно их и содержит. */
export function continuationOutcomes(req: LlmRequest, pendingIds: Set<string>): ToolOutcome[] | undefined {
  const last = req.messages[req.messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content === "string") return undefined;
  const results = last.content.filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result");
  const texts = last.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text").map((b) => b.text).filter((t) => t.trim());
  const other = last.content.some((b) => b.type !== "tool_result" && b.type !== "text");
  if (other || results.length === 0 || results.length !== pendingIds.size) return undefined;
  if (!results.every((r) => pendingIds.has(r.tool_use_id))) return undefined;
  const outcomes: ToolOutcome[] = results.map((r) => ({ toolUseId: r.tool_use_id, content: r.content, isError: r.is_error }));
  if (texts.length > 0) {
    // Врезки петли (нудж, поправка на ходу, live-контекст) идут в этом же user-сообщении текстом.
    // В сессии SDK отдельного канала для них нет — доносим хвостом последнего результата, размеченно:
    // модель обязана отличать наш статус от вывода инструмента (та же логика, что в транскрипте).
    const lastOut = outcomes[outcomes.length - 1] as ToolOutcome;
    const note = `\n\n### ВЛАДЕЛЕЦ/СИСТЕМА (примечание к этому ходу)\n${texts.join("\n\n")}`;
    lastOut.content = typeof lastOut.content === "string" ? lastOut.content + note : [...lastOut.content, { type: "text", text: note }];
  }
  return outcomes;
}

/** Условия, при которых сессию можно продолжать: та же модель/эффорт/набор инструментов/стабильный system. */
export function sessionFingerprint(req: LlmRequest, model: string, effort: string): string {
  // Навык и каталог в отпечатке: внутри сессии они зафиксированы на старте (в кеш-блок CLI не входят).
  const stable = [req.systemStatic, req.systemSkill, req.systemTools].filter((s) => s && s.trim()).join("\n\n");
  return [model, effort, (req.tools ?? []).map((t) => t.name).join(","), stable].join(" ");
}

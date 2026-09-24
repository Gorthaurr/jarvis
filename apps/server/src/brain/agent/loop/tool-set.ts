// W3 «Петля»: набор инструментов и каталог холодных (§15), пересобирается по tool_load.
import { EXCLUDED_TOOLS } from "./util.js";
import type { AgentDeps } from "../types.js";
import { COLD_TOOL_NAMES, TOOL_SCHEMAS, type ToolSchema, toolCatalogLine } from "@jarvis/tools";
import { hotPromotionsFor } from "../../tools/hot-promotions.js";

export function makeToolSetBuilder(deps: AgentDeps) {
  // Набор = встроенные (минус служебные) + самописные инструменты (§8+ саморасширение):
  // выученные Джарвисом инструменты становятся вызываемыми наравне со штатными.
  // §15 ЛЕНИВАЯ ЗАГРУЗКА: «горячие» инструменты + холодные ТОЛЬКО если их подгрузили через tool_load
  // (per-session activation). Полные схемы холодных НЕ шлём каждый ход (контекст/латентность) — они
  // одной строкой в кешируемом каталоге `systemTools`; модель подгружает по имени. dispatch исполняет
  // инструмент по имени независимо от того, была ли схема в наборе (фолбэк-безопасность).
  const activation = deps.toolActivation; // Set<string> | undefined (имена подгруженных холодных)
  // Причина №5 (USER_SCENARIOS_2026-09-02): холодные obs_request/office_* горячие там, где программа РЕАЛЬНО
  // установлена (по сматченным каналам client.env). Снимок на задачу — префикс кеша стабилен внутри неё.
  const promoted = hotPromotionsFor(deps.appChannels);
  const isHot = (t: ToolSchema): boolean =>
    !EXCLUDED_TOOLS.has(t.name) && (!COLD_TOOL_NAMES.has(t.name) || Boolean(activation?.has(t.name)) || promoted.has(t.name));
  const mcpTools = deps.mcp?.asToolSchemas() ?? []; // § MCP-инструменты (все холодные)
  /**
   * Набор инструментов и каталог холодных ПЕРЕСОБИРАЮТСЯ по ходу задачи.
   *
   * 🔴 Живой эпизод 2026-09-01: набор считался ОДИН раз перед циклом, поэтому подгруженный
   * `tool_load`-ом инструмент в ЭТОЙ петле так и не появлялся. Модель звала `tool_load` снова и
   * снова (три раза подряд, пока не сработал анти-runaway) и честно доложила владельцу «инструмент
   * так и не поднялся». На основном канале дефект маскировал фолбэк dispatch (исполняет по имени и
   * без схемы), но в резерве на подписке инструменты — это MCP-инструменты SDK: чего нет в наборе,
   * того не вызвать. Дозапись схем в ХВОСТ `tools` — разовая перезапись префикса кеша, ровно как
   * rolling-брейкпоинт (§15), и она дешевле лишнего круга «подгрузил → не увидел → подгрузил снова».
   */
  const buildToolSet = (): { tools: ToolSchema[]; systemTools: string | undefined } => {
    const list = [
      ...TOOL_SCHEMAS.filter(isHot),
      ...(deps.dynamicTools?.asToolSchemas(deps.userId) ?? []),
      ...mcpTools.filter((t) => activation?.has(t.name)), // активированные через tool_load MCP → в набор
    ];
    // Каталог холодных (не подгруженных) — компактные однострочники, кешируемый блок (buildSystemBlocks).
    const coldCatalog = [
      ...TOOL_SCHEMAS.filter((t) => COLD_TOOL_NAMES.has(t.name) && !EXCLUDED_TOOLS.has(t.name) && !activation?.has(t.name) && !promoted.has(t.name)).map(toolCatalogLine),
      ...mcpTools.filter((t) => !activation?.has(t.name)).map((t) => `- ${t.name}: ${String(t.description || "").slice(0, 100)}`),
    ];
    return {
      tools: list,
      systemTools: coldCatalog.length
        ? `# Инструменты по запросу\nЕсть и другие инструменты (в т.ч. внешние MCP) — их полные описания не загружены. Нужен один — вызови tool_load{names:[...]}, и он станет доступен со СЛЕДУЮЩЕГО ШАГА этой же задачи:\n${coldCatalog.join("\n")}`
        : undefined,
    };
  };
  return buildToolSet;
}

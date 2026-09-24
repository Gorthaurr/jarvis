// W3 «Петля»: рефлексия самообучения §8 (вынесена из agent/index.ts дословно).
import { log } from "./util.js";
import type { AgentDeps } from "../types.js";
import { type Tier } from "@jarvis/shared";
import { TOOL_SCHEMAS } from "@jarvis/tools";
import type { LlmContentBlock, LlmMessage } from "../../../integrations/llm.js";
import { type ToolContext, dispatchTool } from "../../tools/dispatch.js";
import { costUsd } from "../../../obs/pricing.js";

/** Узкий набор для рефлексии самообучения (§8): только мета-навыки, без реальных действий. */
export const SELF_LEARN_TOOLS = TOOL_SCHEMAS.filter((t) => t.name === "skill_save" || t.name === "skill_list");
/** Потолок ходов рефлексии самообучения — бэкстоп, не должен раздувать стоимость задачи. */
export const MAX_SELF_LEARN_STEPS = 4;

/**
 * Бэкстоп самообучения (§8 HERMES): после успешной многошаговой задачи без готового навыка
 * предлагаем модели сохранить приём через skill_save. Один-несколько узких ходов (только
 * skill_save/skill_list) — модель либо пишет навык, либо отвечает текстом (отказ). Итог
 * пользователю уже отдан; это фоновая дозапись знания, она не влияет на голосовой ответ.
 */
export async function selfLearnSkill(args: {
  deps: AgentDeps;
  sys: { staticPrefix: string; dynamicSuffix: string };
  convo: LlmMessage[];
  finalText: string;
  round: number;
  toolTrajectory: readonly string[];
  toolCtx: ToolContext;
  tier: Exclude<Tier, "tier0">;
  model: string;
  taskId: string;
  wasResearched: boolean;
}): Promise<string | null> {
  const { deps, sys, convo, finalText, round, toolTrajectory, toolCtx, tier, model, taskId, wasResearched } = args;
  const trajectory = toolTrajectory.length > 0 ? toolTrajectory.join(" → ") : "—";
  const nudge =
    `[самообучение §8] Задача решена за ${round} шагов` +
    (wasResearched
      ? " — причём способ ты НАШЁЛ сам через web_search/web_fetch. Это и есть самый ценный навык: "
      : ", готового навыка не было. ") +
    "СОХРАНИ приём одним вызовом skill_save({name, when, procedure}), если он пригодится для похожих " +
    "задач: описывай обобщённо (без разовых значений этой задачи), procedure — шаги по порядку + " +
    "грабли + как проверить результат. " +
    `Твоя траектория инструментов: ${trajectory}. ` +
    "Если приём разовый и сохранять нечего — просто ответь коротким текстом, без вызова инструмента.";
  // Хвост диалога заканчивается user-сообщением (tool_result) — добавляем ассистентский итог
  // и user-нудж, чтобы convo по-прежнему оканчивался пользователем (Opus 4.8 не берёт префилл).
  const reflectConvo: LlmMessage[] = [
    ...convo,
    { role: "assistant", content: finalText },
    { role: "user", content: nudge },
  ];

  // Отдельный счётчик шагов под рефлексию: иначе длинная (у потолка maxStepsPerTask) задача —
  // ровно та, которой навык нужнее всего — не смогла бы сохранить приём (§14). spendCap и
  // kill-switch (глобальные) при этом продолжают действовать — платный цикл всё равно ограничен.
  const reflectId = `${taskId}:reflect`;
  try {
    for (let s = 0; s < MAX_SELF_LEARN_STEPS; s += 1) {
      const guard = deps.spend.check(reflectId, 0.01, 2000);
      if (!guard.allowed) {
        // Отличаем «предохранитель не пустил» от «модель решила не сохранять» (телеметрия).
        log.info("самообучение пропущено предохранителем (§14)", { reason: guard.reason });
        return null;
      }

      const resp = await deps.llm.complete({
        tier,
        model,
        systemStatic: sys.staticPrefix,
        systemDynamic: sys.dynamicSuffix || undefined,
        messages: reflectConvo,
        tools: SELF_LEARN_TOOLS,
      });
      deps.spend.recordStep(reflectId);
      deps.spend.recordUsage(reflectId, resp.usage.inputTokens + resp.usage.outputTokens, costUsd(model, resp.usage));
      deps.usageSink?.({ taskId: reflectId, model, usage: resp.usage, costUsd: costUsd(model, resp.usage), kind: "reflect", channel: resp.channel === "subscription" ? "subscription" : "api" });

      if (resp.toolUses.length === 0) return null; // модель решила не сохранять — это нормально

      const assistantBlocks: LlmContentBlock[] = [];
      if (resp.thinkingBlocks?.length) assistantBlocks.push(...resp.thinkingBlocks); // thinking ПЕРВЫМИ (req. API)
      if (resp.text) assistantBlocks.push({ type: "text", text: resp.text });
      for (const tu of resp.toolUses) {
        assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      }
      reflectConvo.push({ role: "assistant", content: assistantBlocks });

      const resultBlocks: LlmContentBlock[] = [];
      let saved = false;
      let savedId: string | null = null;
      for (const tu of resp.toolUses) {
        const r = await dispatchTool(tu.name, tu.input, toolCtx);
        resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: r.isError });
        if (tu.name === "skill_save" && !r.isError) {
          saved = true;
          savedId = (r.data as { id?: string } | undefined)?.id ?? null; // §8 МАКРОС: id для дозаписи реплея
        }
      }
      reflectConvo.push({ role: "user", content: resultBlocks });
      if (saved) {
        log.info("самообучение: навык сохранён после задачи (§8)");
        return savedId;
      }
    }
  } finally {
    deps.spend.finishTask(reflectId); // не копим счётчики ephemeral-метра рефлексии
  }
  return null;
}

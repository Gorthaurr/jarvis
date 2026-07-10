/**
 * §Волна3 (3.1) — Префилл needsLlm-шагов навыка ДЕШЁВЫМ тиром ПЕРЕД реплеем.
 *
 * Закрывает TODO M4+: раньше needsLlm-шаг («сочинить текст по месту») честно валил весь
 * $0-реплей, потому что escalate-канал клиент↔сервер не был подключён. Вместо round-trip
 * посреди исполнения — СЕРВЕР заполняет параметры таких шагов ОДНИМ дешёвым вызовом ДО
 * отправки: план навыка известен, контекст задачи есть, модели остаётся вписать значения.
 *
 * ЧЕСТНОСТЬ: не заполнилось (сбой/невалидный JSON/пустые params) → null — вызывающий НЕ
 * реплеит вслепую (незаполненный шаг = ложный результат), а идёт обычной LLM-петлёй.
 */
import type { SkillStep } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import type { ILlmProvider } from "../../integrations/llm.js";

const log: Logger = createLogger("skill-prefill");

export interface PrefillDeps {
  llm: ILlmProvider;
  /** Дешёвый исполнительский тир (§Волна3 3.2): заполнение значений — механика, не рассуждение. */
  model: string;
}

/** Кап шагов на префилл — навык с десятком «сочини по месту» реплеить не стоит вовсе. */
const MAX_PREFILL_STEPS = 4;

/**
 * Заполнить params всех needsLlm-шагов одним дешёвым вызовом. Возвращает НОВЫЙ массив шагов
 * (needsLlm снят у заполненных) или null — заполнить не вышло, реплей невозможен.
 * Шагов с needsLlm нет → исходный массив как есть (нулевая цена).
 */
export async function prefillNeedsLlmSteps(
  deps: PrefillDeps,
  taskText: string,
  skillName: string,
  steps: readonly SkillStep[],
): Promise<SkillStep[] | null> {
  const needy = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.needsLlm === true);
  if (needy.length === 0) return [...steps];
  if (needy.length > MAX_PREFILL_STEPS) {
    log.debug("префилл пропущен: слишком много needsLlm-шагов", { count: needy.length });
    return null;
  }

  const stepDesc = needy
    .map(({ s, i }) => `- шаг ${i}: action=${s.action}, текущие params=${JSON.stringify(s.params ?? {})}`)
    .join("\n");
  const prompt =
    `Задача пользователя: «${taskText}».\n` +
    `Реплеится навык «${skillName}». Часть шагов требует значений «по месту» (needsLlm). ` +
    `Заполни ИХ params под ЭТУ задачу.\n${stepDesc}\n` +
    `Ответь ТОЛЬКО JSON-объектом вида {"<индекс шага>": {"<имя параметра>": "<значение>"}} — ` +
    `без пояснений и markdown. Типовые параметры: text (что напечатать), combo (клавиши), value.`;

  try {
    const resp = await deps.llm.complete({
      tier: "sonnet",
      model: deps.model,
      systemStatic: "Ты заполняешь параметры шагов автоматизации. Отвечаешь строго JSON-объектом.",
      messages: [{ role: "user", content: prompt }],
      tools: [],
      maxTokens: 600,
    });
    if (resp.stubbed || resp.stopReason === "stub") return null;
    const m = /\{[\s\S]*\}/.exec(resp.text ?? "");
    if (!m) return null;
    const filled = JSON.parse(m[0]) as Record<string, Record<string, unknown>>;
    const out = steps.map((s) => ({ ...s }));
    for (const { i } of needy) {
      const params = filled[String(i)];
      if (!params || typeof params !== "object" || Object.keys(params).length === 0) {
        log.debug("префилл неполный — шаг без значений, реплей отменён", { step: i });
        return null; // ЧЕСТНОСТЬ: частично заполненный план не реплеим
      }
      out[i] = { ...out[i]!, params: { ...(out[i]!.params ?? {}), ...params }, needsLlm: false };
    }
    log.info("§Волна3: needsLlm-шаги заполнены дешёвым тиром перед реплеем", { steps: needy.length });
    return out;
  } catch (e) {
    log.debug("префилл не удался", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

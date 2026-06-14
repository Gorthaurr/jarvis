/**
 * Агент-цикл brain (§7, §8, §15, §21).
 *
 * Поток:
 *   1. classifyTier (router §7). tier0 «открой/запусти X» → ActionCommand round-trip (M0).
 *   2. Иначе — agent-loop на выбранном тире:
 *      retrieval из эпизодической памяти (§8) → системный промпт (персона §11 + факты)
 *      → LLM с инструментами (§6, §12) → исполнение tool-use (dispatchTool) → повтор
 *      до финального текста. Предохранитель — SpendGuard (max шагов/токенов §14).
 *   3. Финальный текст → verbalize (§21) → {voice, display?}.
 *
 * Эскалация тира (§7): тир выбирается ДО генерации (Haiku-классификатор/эвристика);
 * если сложность всплыла в петле — это место для филлера «секунду» и продолжения на
 * старшем тире (// TODO: динамическая эскалация).
 */
import type { ActionCommand } from "@jarvis/protocol";
import { DEFAULT_ACTION_TIMEOUT_MS, newId } from "@jarvis/protocol";
import { type Logger, type Tier, createLogger } from "@jarvis/shared";
import { TOOL_SCHEMAS } from "@jarvis/tools";
import { buildActionLogEntry, insertActionLog } from "../../db/action-log.js";
import type { Session } from "../../gateway/session.js";
import type { ILlmProvider, LlmContentBlock, LlmMessage } from "../../integrations/llm.js";
import type { IWebProvider } from "../../integrations/web.js";
import type { EpisodicMemory } from "../../memory/episodic.js";
import type { WorkingMemory } from "../../memory/working.js";
import type { SpendGuard } from "../../billing/index.js";
import { type UserContextSlot, buildSystemPrompt } from "../persona/index.js";
import { type LocalIntent, classifyTier } from "../router/index.js";
import { dispatchTool } from "../tools/dispatch.js";
import { verbalize } from "../verbalize/index.js";

const log: Logger = createLogger("agent");

/** Ответ агента по схеме §21. */
export interface AgentReply {
  voice: string;
  display?: { title?: string; markdown: string };
}

/** Зависимости агента (инъекция для тестируемости и разделения слоёв). */
export interface AgentDeps {
  memory: WorkingMemory;
  llm: ILlmProvider;
  episodic: EpisodicMemory;
  web: IWebProvider;
  /** id моделей по тирам (§7). */
  models: Record<Exclude<Tier, "tier0">, string>;
  spend: SpendGuard;
  userId: string;
  userContext?: UserContextSlot;
}

/** Инструменты, отложенные до следующих срезов (не предлагаем модели сейчас). */
const EXCLUDED_TOOLS = new Set(["order_place", "skill_execute", "demo_record"]);

export async function handleUserText(
  session: Session,
  text: string,
  deps: AgentDeps,
): Promise<AgentReply> {
  const clean = text.trim();
  deps.memory.pushTurn("user", clean);

  const decision = classifyTier(clean);
  log.info("маршрутизация", { tier: decision.tier, reason: decision.reason });

  let reply: AgentReply;
  if (decision.tier === "tier0" && decision.local) {
    reply = await runLocalIntent(session, decision.local);
  } else {
    const tier: Exclude<Tier, "tier0"> = decision.tier === "tier0" ? "haiku" : decision.tier;
    reply = await runAgentLoop(session, clean, tier, deps);
  }

  deps.memory.pushTurn("assistant", reply.voice);
  return reply;
}

/** Полный agent-loop с tool-use (§7, §8). */
async function runAgentLoop(
  session: Session,
  text: string,
  tier: Exclude<Tier, "tier0">,
  deps: AgentDeps,
): Promise<AgentReply> {
  const taskId = `t-${session.sessionId}-${Date.now().toString(36)}`;
  const model = deps.models[tier];

  // Retrieval-augmentation: релевантные факты из эпизодической памяти (§8).
  let facts: string[] = [];
  try {
    const hits = await deps.episodic.search(deps.userId, text, 5);
    facts = hits.map((h) => h.episode.text);
  } catch (e) {
    log.debug("retrieval недоступен", e instanceof Error ? e.message : String(e));
  }

  const sys = buildSystemPrompt({ ...deps.userContext, facts });
  const tools = TOOL_SCHEMAS.filter((t) => !EXCLUDED_TOOLS.has(t.name));

  // Контекст диалога из рабочей памяти (§8).
  const convo: LlmMessage[] = deps.memory
    .recentTurns()
    .map((t) => ({ role: t.role, content: t.text }) as LlmMessage);

  const toolCtx = {
    session,
    web: deps.web,
    episodic: deps.episodic,
    userId: deps.userId,
    // Подтверждение необратимого (§14) — для message_send (UC-2).
    confirm: (summary: string) =>
      session
        .requestConfirm({ requestId: newId(), summary, kind: "send", expiresAt: Date.now() + 60_000 })
        .then((r) => ({ approved: r.approved, revision: r.revision })),
  };
  let finalText = "";

  // Жёсткий кап шагов + предохранитель SpendGuard (max шагов/токенов/трат §14).
  const HARD_STEP_CAP = 50;
  for (let step = 0; step < HARD_STEP_CAP; step += 1) {
    const guard = deps.spend.check(taskId, 0.01, 2000);
    if (!guard.allowed) {
      log.warn("предохранитель остановил петлю", { reason: guard.reason });
      finalText = "Остановился — достигнут лимит на задачу.";
      break;
    }

    const resp = await deps.llm.complete({
      tier,
      model,
      systemStatic: sys.staticPrefix,
      systemDynamic: sys.dynamicSuffix || undefined,
      messages: convo,
      tools,
    });
    deps.spend.recordStep(taskId);
    deps.spend.recordUsage(taskId, resp.usage.inputTokens + resp.usage.outputTokens, estimateCost(resp.usage));

    if (resp.toolUses.length === 0) {
      finalText = resp.text || "Готово.";
      break;
    }

    // Реплеим ход ассистента (текст + tool_use) и результаты инструментов.
    const assistantBlocks: LlmContentBlock[] = [];
    if (resp.text) assistantBlocks.push({ type: "text", text: resp.text });
    for (const tu of resp.toolUses) {
      assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    }
    convo.push({ role: "assistant", content: assistantBlocks });

    const resultBlocks: LlmContentBlock[] = [];
    for (const tu of resp.toolUses) {
      const r = await dispatchTool(tu.name, tu.input, toolCtx);
      log.info("tool", { name: tu.name, isError: r.isError });
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: r.content,
        is_error: r.isError,
      });
    }
    convo.push({ role: "user", content: resultBlocks });
  }

  deps.spend.finishTask(taskId);
  if (!finalText) finalText = "Готово.";
  return { voice: verbalize(finalText) };
}

/** tier0: локальный интент как одно действие round-trip (§5). */
async function runLocalIntent(session: Session, intent: LocalIntent): Promise<AgentReply> {
  const command = intentToCommand(intent);
  const result = await session.sendAction(command, DEFAULT_ACTION_TIMEOUT_MS);
  void insertActionLog(buildActionLogEntry(session.sessionId, result.commandId, command, result));
  if (result.ok) return { voice: verbalize(successPhrase(intent)) };
  log.warn("локальное действие не удалось", { kind: command.kind, code: result.error?.code });
  return { voice: verbalize(failurePhrase(intent, result.error?.code)) };
}

function intentToCommand(intent: LocalIntent): ActionCommand {
  switch (intent.kind) {
    case "app.launch":
      return { kind: "app.launch", app: intent.app };
    case "app.focus":
      return { kind: "app.focus", app: intent.app };
    case "browser.open":
      return { kind: "browser.open", url: intent.url };
  }
}

function successPhrase(intent: LocalIntent): string {
  switch (intent.kind) {
    case "app.launch":
      return `Открыл ${intent.app}.`;
    case "app.focus":
      return `Переключился на ${intent.app}.`;
    case "browser.open":
      return "Открыл.";
  }
}

function failurePhrase(intent: LocalIntent, code?: string): string {
  const reason =
    code === "timeout"
      ? "не дождался ответа"
      : code === "not_found"
        ? "не нашёл"
        : code === "disconnected"
          ? "связь с клиентом прервалась"
          : "не получилось";
  switch (intent.kind) {
    case "app.launch":
      return `Не вышло открыть ${intent.app}: ${reason}.`;
    case "app.focus":
      return `Не вышло переключиться на ${intent.app}: ${reason}.`;
    case "browser.open":
      return `Не вышло открыть страницу: ${reason}.`;
  }
}

/** Грубая оценка стоимости вызова (для spend cap §14). Цены — порядок величины. */
function estimateCost(usage: { inputTokens: number; outputTokens: number }): number {
  return (usage.inputTokens * 1 + usage.outputTokens * 5) / 1_000_000;
}

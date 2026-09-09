// W3 «Петля»: контекст задачи (LoopCtx) — всё, что фазы читают, но не переопределяют; собирается один раз перед циклом.
import { makeLeaseHelpers } from "./input-lease.js";
import { retrieveContext } from "./retrieval.js";
import { buildPrompt } from "./prompt.js";
import { makeToolSetBuilder } from "./tool-set.js";
import { buildConvo } from "./convo.js";
import { makeToolCtx } from "./tool-ctx.js";
import { makeNoteHelpers } from "./checkpoint-save.js";
import { makeTierHelpers } from "./tiering.js";
import { TaskManager } from "../../tasks/manager.js";
import type { Task } from "../../tasks/task.js";
import type { RecalledSkill } from "../../../memory/skills.js";
import type { CheckpointReason } from "../checkpoint.js";
import type { LoopState } from "./state.js";
import type { LoopConfig } from "./config.js";
import type { AgentDeps, ReplySink, LoopOpts } from "../types.js";
import type { ToolContext } from "../../tools/dispatch.js";
import type { AsyncMutex, Tier } from "@jarvis/shared";
import type { ToolSchema } from "@jarvis/tools";
import type { Session } from "../../../gateway/session.js";
import type { LlmMessage } from "../../../integrations/llm.js";
import { buildSystemPrompt } from "../../persona/index.js";
import { thinkingEnabled } from "../thinking-policy.js";

export interface LoopBase { session: Session; text: string; tier: Exclude<Tier, "tier0">; deps: AgentDeps; sink: ReplySink | undefined; opts: LoopOpts | undefined; st: LoopState; task: Task; taskId: string; tasks: TaskManager; isConversational: boolean; cfg: LoopConfig }

export interface LoopCtx extends LoopBase {
  arbiter: AsyncMutex | undefined;
  recalled: RecalledSkill | null;
  sys: ReturnType<typeof buildSystemPrompt>;
  convo: LlmMessage[];
  toolCtx: ToolContext;
  priorDigest: string | undefined;
  buildToolSet: () => { tools: ToolSchema[]; systemTools: string | undefined };
  ensureInput: () => Promise<boolean>;
  showStatus: () => void;
  notePartial: (source: string, k: number) => void;
  effectOf: (name: string) => "verify" | "mutate" | "neutral";
  pushSystemNote: (note: string) => void;
  saveCheckpoint: (reason: CheckpointReason, opts2?: { deliverable?: boolean }) => boolean;
  escalateForQuality: (reason: string) => void;
  loopMaxMs: () => number;
}

/** Порядок сборки повторяет прежнюю петлю: ожидания (retrieval, факты) идут ДО отметки старта потолка задачи. */
export async function buildLoopContext(base: LoopBase): Promise<LoopCtx> {
  const { session, text, tier, deps, sink, opts, st, task, taskId, tasks, cfg } = base;
  // Аренда ввода (§20): задача занимает мышь/клаву на ПЕРВОЙ GUI-команде и держит до
  // конца (исключает interleave кликов/печати с другой параллельной задачей). Пока
  // занимается только чтением/web/памятью/кодом — ввод свободен для других задач.
  // Волна 1 (эпизод 2026-07-10): (а) ожидание аренды БОЛЬШЕ НЕ входит в потолок времени задачи —
  // вторая GUI-задача сгорала в очереди, сделав 2 инструмента за 245с; (б) ожидание ограничено
  // JARVIS_INPUT_WAIT_MS (деф 60с) — по таймауту GUI-инструмент получает честную ошибку «ввод занят»,
  // и модель решает сама (работать без ввода / завершить честно); (в) после долгого ожидания
  // слепое действие блокируется до свежего взгляда (клик по устаревшему кадру = промах — живой случай:
  // клик выстрелил через 236с очереди по давно изменившемуся экрану).
  const arbiter = deps.inputArbiter;
  const lease = makeLeaseHelpers({ st, arbiter, task, session, cfg });
  const { facts, recalled, skillCatalog } = await retrieveContext(deps, text, sink);
  const sys = await buildPrompt({ deps, opts, tasks, taskId, recalled, facts, skillCatalog });
  const buildToolSet = makeToolSetBuilder(deps);
  ({ tools: st.arsenal.tools, systemTools: st.arsenal.systemTools } = buildToolSet());
  const convo = buildConvo(deps, text, opts);
  const toolCtx = makeToolCtx(deps, session, opts);
  st.budget.loopStartMs = Date.now();
  /**
   * Журнал ПРОШЛЫХ заходов — снимок на входе в петлю (контрольное ревью-3). Оба места, где журнал
   * склеивается (обновление и сохранение), обязаны мержить ОДИН И ТОТ ЖЕ prior: иначе второй мерж
   * получал уже смерженное и дублировал текущий заход, вытесняя первый.
   */
  const priorDigest = opts?.resumeFrom?.digest;
  const notes = makeNoteHelpers({ deps, opts, st, task, taskId, text, convo, priorDigest });
  st.budget.lastLiveCtx = (deps.userContext?.systemContext ?? "").trim();
  st.budget.lastSelectionKey = deps.selection?.key() ?? "";
  st.tier.prevRoundModel = st.tier.model;
  st.tier.prevThinkingOn = thinkingEnabled(deps.tierThinking?.[tier]);
  const tiers = makeTierHelpers({ deps, st, cfg });
  return { ...base, arbiter, recalled, sys, convo, toolCtx, priorDigest, buildToolSet, ...lease, ...notes, ...tiers };
}

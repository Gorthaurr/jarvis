// W3 «Петля»: контекст диалога из рабочей памяти + журнал продолжения (волна C).
import { log, appendUserNote } from "./util.js";
import type { AgentDeps, LoopOpts } from "../types.js";
import type { LlmMessage } from "../../../integrations/llm.js";
import { buildResumePrompt } from "../checkpoint.js";

export function buildConvo(deps: AgentDeps, text: string, opts: LoopOpts | undefined): LlmMessage[] {
  // Контекст диалога из рабочей памяти (§8). §20: «обособленная» новая задача (freshContext) НЕ
  // наследует ВЕСЬ контекст текущей, но и НЕ начинается слепой — иначе вопрос-продолжение («ты
  // отправил?», «ну что?») терял весь диалог и Джарвис отвечал «не вижу, о каком сообщении речь»
  // (реальный баг «забывашка»). Поэтому свежая задача берёт КОРОТКОЕ окно последних реплик
  // (continuity без раздувания), обычный ход — полный недавний диалог.
  const FRESH_CONTEXT_WINDOW = 10;
  const turns = opts?.freshContext ? deps.memory.recentTurns(FRESH_CONTEXT_WINDOW) : deps.memory.recentTurns();
  // W0: пустые реплики (тихий финал отменённой задачи и т.п.) в промпт не идут — пустой content = 400 у API.
  const convo: LlmMessage[] = turns.filter((t) => t.text.trim().length > 0).map((t) => ({ role: t.role, content: t.text }) as LlmMessage);
  // Opus 4.8 не принимает префилл: convo ДОЛЖЕН заканчиваться сообщением пользователя.
  // Страховка от хвостовых assistant-сообщений (дворецкий ack, гонки фоновых задач).
  while (convo.length > 0 && convo[convo.length - 1]?.role !== "user") convo.pop();
  // W0: цель петли — ЯВНЫЙ text этой команды. Задача, простоявшая в очереди за семафором, стартует, когда
  // в рабочей памяти последней может лежать уже ДРУГАЯ реплика владельца — модель исполнила бы не ту команду.
  const lastUser = convo.length > 0 ? convo[convo.length - 1] : undefined;
  if (!lastUser || lastUser.content !== text) convo.push({ role: "user", content: text } as LlmMessage);
  // Волна C (P0 #4): ПРОДОЛЖЕНИЕ прерванной задачи — журнал прошлого захода идёт ХВОСТОМ (как steer/
  // live-рефреш): system-блок не пересобирается, кеш персоны §15 цел. Журнал компактен и текстов —
  // никаких tool_use/thinking-инвариантов Anthropic на резюме (см. checkpoint.ts, «почему журнал»).
  if (opts?.resumeFrom) {
    appendUserNote(convo, buildResumePrompt(opts.resumeFrom));
    log.info("§волна C: продолжаю прерванную задачу", {
      of: opts.resumeFrom.taskId,
      reason: opts.resumeFrom.reason,
      roundsBefore: opts.resumeFrom.round,
      ageMs: Date.now() - opts.resumeFrom.savedAt,
    });
  }
  return convo;
}

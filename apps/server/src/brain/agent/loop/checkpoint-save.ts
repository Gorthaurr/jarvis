// W3 «Петля»: служебные врезки петли и чекпойнт прерванной задачи (волна C).
import { log, appendUserNote } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { LoopState } from "./state.js";
import type { AgentDeps, LoopOpts } from "../types.js";
import type { LlmMessage } from "../../../integrations/llm.js";
import { type CheckpointReason, type TaskCheckpoint, buildResumeDigest, mergeDigests } from "../checkpoint.js";
import { toolEffect } from "../error-voice.js";

export interface NoteCore { deps: AgentDeps; opts: LoopOpts | undefined; st: LoopState; task: LoopCtx["task"]; taskId: string; text: string; convo: LlmMessage[]; priorDigest: string | undefined }

export function makeNoteHelpers(core: NoteCore) {
  const { deps, opts, st, task, taskId, text, convo, priorDigest } = core;
  /**
   * Эффект инструмента с учётом ДЕКЛАРАЦИИ MCP-сервера (mcp.json), а не только эвристики по имени:
   * тем же контрактом пользуется петля, значит свёртка наблюдений и журнал обязаны видеть то же самое
   * (иначе «мутирующий get_*» сворачивался бы как перечитываемый, а нейтральный `think` попадал в
   * «СДЕЛАНО»).
   */
  const effectOf = (name: string): "verify" | "mutate" | "neutral" => deps.mcp?.declaredEffect?.(name) ?? toolEffect(name);
  /** Впрыснуть служебную врезку в user-роль и запомнить, что она НАША (не речь владельца). */
  const pushSystemNote = (note: string): void => {
    st.progress.systemNotes.add(note);
    appendUserNote(convo, note);
  };
  /**
   * Волна C (P0 #4): сохранить ЧЕКПОЙНТ прерванной задачи, чтобы «продолжи» действительно продолжало.
   *
   * Возвращает true — только если продолжение РЕАЛЬНО возможно; терминал по этому флагу решает,
   * предлагать ли «Продолжить с того же места?». Обещать продолжение без чекпойнта нельзя — ровно
   * это и было ложью до Волны C.
   *
   * Сохраняем ЖУРНАЛ (buildResumeDigest), а не сырой convo — обоснование в checkpoint.ts.
   * Не сохраняем: разговорный ход (продолжать нечего — это вопрос) и ход без единого раунда
   * (журнал был бы пуст, «продолжение» выродилось бы в повтор исходной команды).
   *
   * Волна E: объявлен ДО петли — им пользуется и страховочный снимок на 70%-нудже (замыкания видят
   * live-значения round/committedToolRounds/convo, место объявления семантику не меняет).
   */
  const saveCheckpoint = (reason: CheckpointReason, opts2?: { deliverable?: boolean }): boolean => {
    // Машинный реэнтри (watch-action) чекпойнта НЕ оставляет (ревью): слот один на пользователя, и
    // сгенерированное поручение наблюдения перетирало бы недоделку ВЛАДЕЛЬЦА — его «доделай» тогда
    // доводило бы ЧУЖУЮ задачу. Продолжать машинное поручение владелец и не просил.
    if (!deps.checkpoints || opts?.conversational || opts?.machine || st.progress.committedToolRounds < 1) return false;
    try {
      const cp: TaskCheckpoint = {
        userId: deps.userId,
        taskId,
        goal: text,
        title: task.title,
        reason,
        // Обрыв канала/отмена посреди раунда выходят из петли ДО `round += 1`, а мутации уже совершены —
        // сообщать «сделано шагов: 0» при реально сделанной отправке нельзя (контрольное ревью-3).
        round: Math.max(st.progress.round, st.progress.committedToolRounds),
        savedAt: Date.now(),
        tier: st.tier.currentTier,
        // Цепочка продолжений помнит ВСЁ: журнал прошлых заходов склеивается с текущим (ревью:
        // иначе третий заход не видел отправок первого и мог повторить их людям).
        digest: mergeDigests(priorDigest, buildResumeDigest(convo, { systemNotes: st.progress.systemNotes, effectOf, confirmedSends: st.honesty.confirmedSends, declinedCalls: st.honesty.declinedCalls, uncertainCalls: st.honesty.uncertainCalls, partialCalls: st.honesty.partialCalls })),
        ...(deps.toolActivation?.size ? { toolNames: [...deps.toolActivation] } : {}),
      };
      const ok = deps.checkpoints.save(cp, opts?.resumeFrom?.taskId);
      // Окно «мы предложили» взводится ТОЛЬКО когда предложение реально ДОШЛО до владельца. При
      // мёртвом канале (channelLost) фраза уходит в закрытый сокет и пропадает — взводить окно нельзя
      // (контрольное ревью-2): владелец ничего не слышал, а сказанное плееру «продолжи» подняло бы
      // задачу. `доделай` при этом работает весь TTL — обещание не теряется, только окно не открываем.
      // Плюс: сессия должна быть ЖИВА — в закрытую фраза-предложение не уйдёт ни голосом, ни в чат
      // (контрольное ревью-3). Недо-обещание безопасно: «доделай» работает весь TTL и без окна.
      if (ok && opts2?.deliverable !== false && !deps.isClosed?.()) deps.checkpoints.markOffered(deps.userId, taskId);
      log.info("§волна C: чекпойнт прерванной задачи сохранён", { taskId, reason, round: st.progress.round, durable: ok, digest: cp.digest.length });
      return ok;
    } catch (e) {
      // Чекпойнт — удобство, а не контракт задачи: его сбой не должен ломать терминал.
      log.warn("не удалось сохранить чекпойнт задачи", { taskId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };
  return { effectOf, pushSystemNote, saveCheckpoint };
}

// W3 «Петля»: отложенный ack долгой фоновой задачи (§20).
import { log } from "./util.js";
import type { LoopCtx } from "./context.js";
import { verbalize } from "../../verbalize/index.js";

export function armAckTimer(ctx: LoopCtx): void {
  const { deps, sink, st, task, taskId, isConversational } = ctx;
  // §20 ОТЛОЖЕННЫЙ ACK долгой фоновой задачи (аудит лога 2026-07-03: «прекрати поиск у доти» —
  // 33с полной тишины → пользователь снял задачу вручную, не зная, идёт ли она). «Тихий финал»
  // остаётся законом (никаких безусловных «Принял» на каждом ходе): фоновая задача (без sink)
  // живёт дольше порога и ни одна фраза не прозвучала → ОДИН короткий прогресс-маячок.
  // Cancel-safe ПО КОНСТРУКЦИИ: таймер читает task.cancel/state/spokeAny В МОМЕНТ срабатывания
  // (ровно требование из ретро ButlerAcks — слепой agent-таймер, не видящий cancel, стрелял
  // ack'ом после «отмени»). clearTimeout — в finally петли. env JARVIS_TASK_ACK_MS, 0 = выкл.
  // Волна 1: дефолт 8000 → 4000 (эмпирический порог повтора команды пользователем — 4-6с тишины;
  // первый индикатор теперь earcon в момент приёмки, «Занимаюсь» — второй эшелон для долгих задач;
  // 2000 из плана отвергнуто: каждая 3-5-секундная фоновая задача получала бы лишнюю фразу).
  const taskAckMs = (() => {
    const n = Number.parseInt(process.env.JARVIS_TASK_ACK_MS ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : 4000;
  })();
  // Разговорный ход (вопрос/смолток) ack НЕ получает — «вопрос ≠ задача, нет карточки/ack» (карта проекта).
  // Живой прогон 2026-09-02: в текстовом канале «сколько будет два плюс два» отвечало «Занимаюсь, сэр» и лишь
  // потом ответ — болтливость на пустом месте.
  if (!sink && !isConversational && deps.speakResult && taskAckMs > 0) {
    st.progress.ackTimer = setTimeout(() => {
      if (task.cancel.cancelled || task.state !== "running" || st.progress.spokeAny || deps.isClosed?.()) return;
      st.progress.spokeAny = true; // прозвучала фраза → сбойный терминал строит «…продолжение», не противоречит
      log.info("§20 отложенный ack: задача идёт дольше порога — говорю прогресс", { taskId, ms: taskAckMs });
      deps.speakResult?.({ voice: verbalize("Занимаюсь, сэр.") });
    }, taskAckMs);
    st.progress.ackTimer.unref?.();
  }
}

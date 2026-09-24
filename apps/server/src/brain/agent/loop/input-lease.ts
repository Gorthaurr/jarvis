// W3 «Петля»: аренда ввода §20 и чип задачи — хелперы, замкнутые на состояние задачи.
import { emitTaskStatus } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { LoopState } from "./state.js";
import type { LoopConfig } from "./config.js";

export interface LeaseCore { st: LoopState; arbiter: LoopCtx["arbiter"]; task: LoopCtx["task"]; session: LoopCtx["session"]; cfg: LoopConfig }

export function makeLeaseHelpers(core: LeaseCore) {
  const { st, arbiter, task, session } = core;
  const { INPUT_WAIT_MS } = core.cfg;
  /**
   * Контроль-9 (veil-partial-macro-erased): ЕДИНСТВЕННАЯ точка пересчёта. Контроль-8 заменил накопление `+=` на
   * присваивание суммы по источникам, но АВТО-МАКРОС остался на `+=` и в карту не попадал — первый же отказ вуали
   * со `stepIndex: 0` (раннер срезал ПЕРВЫЙ шаг берста) присваивал сумму 0 и стирал вклад макроса: терминал говорил
   * «нужное действие я при этом не сделал» про три уже совершённых необратимых шага, владелец повторял команду.
   */
  const notePartial = (source: string, k: number): void => {
    st.honesty.partialBySource.set(source, k);
    st.honesty.overlayPartialTotal = [...st.honesty.partialBySource.values()].reduce((a, b) => a + b, 0);
  };
  const ensureInput = async (): Promise<boolean> => {
    if (!arbiter) return true;
    if (st.progress.holdsInput) return true;
    const t0 = Date.now();
    const got = await arbiter.acquireWithTimeout(INPUT_WAIT_MS);
    const waited = Date.now() - t0;
    if (waited > 0) {
      st.budget.queueWaitMs += waited;
      st.budget.loopStartMs += waited; // потолок задачи не тикает, пока стоим в очереди за арендой
    }
    if (!got) {
      // 🔴 Признак ставим ЗДЕСЬ, а не у call-site (адверс-ревью 2026-09-02, HIGH): отказ аренды
      // рождается в одном месте, а потребителей два — tool-цикл и БЫСТРЫЙ РЕПЛЕЙ макроса (§8).
      // Реплей ловил отказ своим catch, флаг не ставился, и голосовой ход заканчивался `done` +
      // «Готово, сэр — поиск игры запущен», хотя не выполнилось НИ ШАГА; навыку при этом писался
      // УСПЕХ (recordOutcome). Тот же дефект «Доты», просто в соседней ветке.
      st.honesty.inputDenied = true;
      return false;
    }
    st.progress.holdsInput = true;
    st.budget.lastAcquireWaitMs = waited;
    // Могли отменить, пока ждали аренду (§20 «отмена ≤1 шага»): сразу отдаём её —
    // петля выйдет на ближайшей проверке cancel, не выполнив GUI-команду.
    if (task.cancel.cancelled) {
      arbiter.release();
      st.progress.holdsInput = false;
    }
    return true;
  };
  const showStatus = (): void => {
    st.progress.shown = true;
    emitTaskStatus(session, task);
  };
  return { notePartial, ensureInput, showStatus };
}

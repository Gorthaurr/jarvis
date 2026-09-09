// W3 «Петля»: снимок признаков через границу раунда (контроль-3) и тайминг раунда.
import type { LoopState } from "./state.js";

export interface RoundSnapshot { gateStoppedPrevRound: boolean; veilStoppedPrevRound: boolean }

export function takeRoundSnapshot(st: LoopState): RoundSnapshot {
  // 🔴 Контроль-3: СНИМОК, а не голый сброс. Флаг ставится в фазе tool_result раунда N, а читает
  // его анти-капитуляция в раунде N+1 (ветка «модель ответила текстом»). Голый сброс в начале
  // итерации стирал его РАНЬШЕ чтения → гард был мёртвым кодом, и после отказа владельца петля
  // всё равно обвиняла модель в капитуляции, эскалировала на Opus и гнала переспрашивать
  // (проверено живым прогоном петли). Снимок переносит признак ровно через одну границу раунда.
  const gateStoppedPrevRound = st.honesty.gateStoppedRound;
  const veilStoppedPrevRound = st.honesty.gateStoppedByVeil;
  st.honesty.gateStoppedRound = false;
  st.honesty.gateStoppedByVeil = false;
  return { gateStoppedPrevRound, veilStoppedPrevRound };
}

export interface RoundTiming { stepStartedMs: number; stepQueueWait0: number; stepIdleWait0: number }

export function startRoundTiming(st: LoopState): RoundTiming {
  // Длительность раунда → roundDurTotalMs (гард бюджета выше). Снапшот ПОСЛЕ паузы (takeover не
  // раздувает avg) + снапшот queueWaitMs: ожидание аренды ВНУТРИ раунда (ensureInput) вычитается —
  // иначе один 50-секундный queue-wait раздувал средний раунд и гард сворачивал задачу зря (ревью B+C).
  const stepStartedMs = Date.now();
  const stepQueueWait0 = st.budget.queueWaitMs;
  const stepIdleWait0 = st.budget.idleWaitMs; // ревью #5: блокирующее ожидание wait_for browser в этом раунде
  return { stepStartedMs, stepQueueWait0, stepIdleWait0 };
}

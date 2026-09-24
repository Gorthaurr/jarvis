/**
 * Гонка sync-first промоушена (ревью 2026-09-24, T-F6/B-F1): когда голосовой ход с действием уходит в фон.
 *
 * Было: таймер 1,5 с. Раунд модели на подписке ≥2,9 с, значит таймер выигрывал ВСЕГДА — «Берусь, сэр» звучал на
 * каждое действие (даже на реплику, на которую модель просто ответила словами), а итог — отдельной фразой позже.
 * Стало: триггер — ФАКТ первого tool_use модели. Ответила текстом → говорим ответ сразу, ack нет. Пошла в
 * инструменты → промоушен (микрофон свободен, итог по готовности). Думает дольше верхнего порога и инструмента
 * нет → всё равно промоушен, чтобы не молчать (см. SYNC_PROMOTE_DEFAULT_MS в index.ts).
 *
 * Пол `floorMs` от начала хода — ради быстрого канала (API ~1 с на раунд): однотуловое действие успевает ответить
 * результатом, как раньше. На подписке первый tool_use приходит позже пола — промоушен по нему немедленный.
 */
export type PromoteOutcome<T> = { kind: "done"; reply: T } | { kind: "error"; error: unknown } | { kind: "slow"; why: "tool" | "cap" };

export interface PromoteRace<T> {
  /** Сигнал петли «модель пошла в инструменты» (подключается к wrap-sink). */
  onToolRound: () => void;
  outcome: Promise<PromoteOutcome<T>>;
}

/**
 * `onPromote` зовётся СИНХРОННО в момент решения о промоушене — вызывающий гасит стрим петли в голосовой канал
 * до того, как та успеет что-то в него сказать (иначе итог прозвучал бы дважды: стримом и через speakResult).
 */
export function promoteRace<T>(loopP: Promise<T>, capMs: number, floorMs: number, onPromote: () => void): PromoteRace<T> {
  const startedAt = Date.now();
  let decided = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let promote: (why: "tool" | "cap") => void = () => {};
  const slowP = new Promise<PromoteOutcome<T>>((resolve) => {
    promote = (why) => {
      if (decided) return;
      decided = true;
      onPromote();
      resolve({ kind: "slow", why });
    };
  });
  const arm = (ms: number, why: "tool" | "cap"): void => {
    const t = setTimeout(() => promote(why), Math.max(0, ms));
    if (typeof t.unref === "function") t.unref();
    timers.push(t);
  };
  arm(capMs, "cap");
  const onToolRound = (): void => {
    if (decided) return;
    const wait = floorMs - (Date.now() - startedAt);
    if (wait <= 0) promote("tool");
    else arm(wait, "tool");
  };
  // onRejected обязателен: без него отклонение петли ПОСЛЕ промоушена стало бы unhandled rejection.
  const doneP = loopP.then(
    (reply): PromoteOutcome<T> => {
      decided = true;
      return { kind: "done", reply };
    },
    (error): PromoteOutcome<T> => {
      decided = true;
      return { kind: "error", error };
    },
  );
  const outcome = Promise.race([doneP, slowP]).finally(() => {
    for (const t of timers) clearTimeout(t);
  });
  return { onToolRound, outcome };
}

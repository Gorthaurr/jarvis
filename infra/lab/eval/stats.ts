/** Сводка прогонов: pass-rate, медиана времени, инструменты; вердикт контрольного прогона. Чистые функции. */
import type { EvalRun, EvalScenarioStats } from "./types.js";

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/**
 * По сценарию: `rate` = pass / все прогоны (консервативно: ошибка прогона не «прячется» из знаменателя, но и не считается
 * провалом мозга — она отдельной колонкой `error`). Время — медиана только по завершённым (pass/fail) прогонам.
 */
export function statsOf(runs: readonly EvalRun[]): Record<string, EvalScenarioStats> {
  const out: Record<string, EvalScenarioStats> = {};
  for (const r of runs) {
    const st = (out[r.scenarioId] ??= { pass: 0, total: 0, rate: 0, medianMs: 0, fail: 0, error: 0, tools: [] });
    st.total += 1;
    st[r.outcome] += 1;
    for (const t of r.tools) if (!st.tools.includes(t)) st.tools.push(t);
    if (r.control) st.control = true;
  }
  for (const [id, st] of Object.entries(out)) {
    st.rate = st.total ? st.pass / st.total : 0;
    st.medianMs = median(runs.filter((r) => r.scenarioId === id && r.outcome !== "error").map((r) => r.ms));
  }
  return out;
}

export interface ControlVerdict {
  id: string;
  /** true — проверка покраснела без мозга, как и должна; false — ЗЕЛЁНАЯ без мозга: проверка декоративна. */
  red: boolean;
}

/** Отрицательный контроль: сценарий real-only без модели обязан не достигаться на КАЖДОМ прогоне (ошибки прогона не в счёт). */
export function controlVerdicts(runs: readonly EvalRun[]): ControlVerdict[] {
  const ids = [...new Set(runs.filter((r) => r.control).map((r) => r.scenarioId))];
  return ids.map((id) => ({ id, red: runs.filter((r) => r.scenarioId === id && r.outcome !== "error").every((r) => !r.pass) }));
}

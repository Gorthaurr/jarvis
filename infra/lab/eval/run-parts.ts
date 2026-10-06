/** Части одного прогона: разговор по шагам, опции сервисов ПК, бюджеты, текст причины. Без состояния между прогонами. */
import { getServiceOptions, setServiceOptions } from "../desktop/service-options.js";
import type { DesktopSnapshot, FakeDesktop, TurnResult } from "../lib/contracts.js";
import type { EvalClient, EvalRun, EvalScenario, Outcome } from "./types.js";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Опции сервисов FakeDesktop глобальны в процессе: применяем на время прогона и возвращаем прежние. */
export function applyServices(patch: EvalScenario["services"]): () => void {
  if (!patch) return () => undefined;
  const prev = { ...getServiceOptions() };
  setServiceOptions(patch);
  return () => setServiceOptions(prev);
}

/**
 * Разговор: цель, затем шаги (тот же клиент = та же партиция памяти). Ход, упёршийся в таймаут, обрывает разговор:
 * говорить дальше с зависшим сервером — гадать. `marks[i]` — снимок «ПК» сразу после хода i.
 */
export async function converse(client: EvalClient, desktop: FakeDesktop, s: EvalScenario, turns: TurnResult[]): Promise<DesktopSnapshot[]> {
  const marks: DesktopSnapshot[] = [];
  const plan = [{ say: s.goal, waitTasks: s.firstWaitTasks ?? true, pauseMs: 0 }, ...(s.steps ?? []).map((x) => ({ waitTasks: true, pauseMs: 0, ...x }))];
  for (const step of plan) {
    if (step.pauseMs) await sleep(step.pauseMs);
    const t = await client.say(step.say, { timeoutMs: s.budget.maxMs, waitTasks: step.waitTasks });
    turns.push(t);
    marks.push(desktop.snapshot());
    if (t.ended === "timeout") break;
  }
  return marks;
}

export const actionCount = (turns: readonly TurnResult[]): number => turns.reduce((n, t) => n + t.actions.length, 0);

/** Какой бюджет исчерпан (время важнее: оно же означает, что итоговое состояние могло быть неполным). */
export function budgetHit(s: EvalScenario, turns: readonly TurnResult[]): EvalRun["budget"] | undefined {
  if (turns.some((t) => t.ended === "timeout")) return "time";
  return s.budget.maxActions !== undefined && actionCount(turns) > s.budget.maxActions ? "actions" : undefined;
}

export function explain(s: EvalScenario, budget: EvalRun["budget"], turns: readonly TurnResult[], checkWhy: string): string {
  if (budget === "time") return `бюджет времени maxMs=${s.budget.maxMs} исчерпан (сервер жив); проверка: ${checkWhy}`;
  if (budget === "actions") return `бюджет действий maxActions=${s.budget.maxActions} превышен (было ${actionCount(turns)}); проверка: ${checkWhy}`;
  return checkWhy;
}

export const outcomeOf = (pass: boolean): Outcome => (pass ? "pass" : "fail");

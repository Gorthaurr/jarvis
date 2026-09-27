/**
 * W2 (П4, G-8/G-19): серия `act{steps}` — несколько шагов рук ОДНИМ вызовом без раундов модели между ними.
 *
 * Маршрут стоит в `dispatchTool` ДО гейтов: каждый шаг проходит `dispatchTool("act", …)` сам — со ВСЕМИ гейтами
 * (§0-пролог, §14 guiGate с вопросом владельцу по одному на шаг, сборка команды по схеме, кадр задачи). Серия — не
 * обход рубежей, а экономия раундов. Шаг `capture` → `dispatchTool("screen_capture")` (кадр виден следующим шагам),
 * `wait` → пауза ≤ 5 с. Промежуточные act без verify идут с `observe:false` (без снимков до/после — сверка будет
 * признаком verify или следующим шагом).
 *
 * Честность: форма серии проверяется ДО первого шага (≤ 12 шагов, вложенных steps нет, поля — только act / capture /
 * wait, сверху — только `app`); стоп на первом isError / uncertain / declined / overlayDenied / channelDown / veiled;
 * `ctx.isCancelled()` и бюджет ~180 с — между шагами. Итог «k из n» и флаги — act-steps-result.ts.
 */
import { sleep } from "@jarvis/shared";
import { ACT_STEPS_MAX, ACT_VERBS, toolInputFields } from "@jarvis/tools";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err } from "../dispatch-util.js";
import { toolCallEffect } from "../../agent/error-voice.js";
import { type StepRecord, type StopReason, seriesResult, stopReasonOf } from "./act-steps-result.js";

/** Рекурсивный вход в dispatchTool (внедряется, чтобы модуль не импортировал диспетчер по кругу). */
export type DispatchFn = (name: string, input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export const SERIES_BUDGET_MS = 180_000;
export const WAIT_MAX_MS = 5_000;

/** Вызов — серия act{steps}? */
export function isActSteps(name: string, input: Record<string, unknown>): boolean {
  return name === "act" && input.steps !== undefined;
}

type Step = { kind: "act" | "capture"; input: Record<string, unknown> } | { kind: "wait"; ms: number };

const VERBS: ReadonlySet<string> = new Set(ACT_VERBS);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const extra = (o: Record<string, unknown>, allowed: ReadonlySet<string>): string[] => Object.keys(o).filter((k) => !allowed.has(k));

/** Разобрать и проверить серию ДО первого шага. Строка — честный отказ (ничего не сделано). */
export function parseSteps(input: Record<string, unknown>): Step[] | string {
  const top = extra(input, new Set(["steps", "app"]));
  if (top.length) return `сверху рядом со steps допускается только app, а пришло: ${top.join(", ")} — положи эти поля в шаги`;
  const raw = input.steps;
  if (!Array.isArray(raw) || raw.length === 0) return "steps — непустой массив шагов";
  if (raw.length > ACT_STEPS_MAX) return `шагов ${raw.length}, максимум ${ACT_STEPS_MAX} — разбей серию`;
  const actFields = new Set([...toolInputFields("act")].filter((f) => f !== "steps"));
  const captureFields = new Set(["do", ...toolInputFields("screen_capture")]);
  const out: Step[] = [];
  for (const [i, s] of raw.entries()) {
    const at = `шаг ${i + 1}`;
    if (!isObj(s)) return `${at}: ожидался объект`;
    if (s.steps !== undefined) return `${at}: вложенные steps запрещены`;
    const verb = s.do === undefined ? "click" : s.do;
    if (verb === "wait") {
      const ms = s.ms;
      if (extra(s, new Set(["do", "ms"])).length) return `${at}: у wait только ms`;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0 || ms > WAIT_MAX_MS) return `${at}: wait.ms — число 1..${WAIT_MAX_MS}`;
      out.push({ kind: "wait", ms });
    } else if (verb === "capture") {
      const bad = extra(s, captureFields);
      if (bad.length) return `${at}: у capture нет полей ${bad.join(", ")}`;
      const { do: _d, ...rest } = s;
      out.push({ kind: "capture", input: rest });
    } else {
      if (typeof verb !== "string" || !VERBS.has(verb)) return `${at}: do «${String(verb)}» — не глагол act (и не capture/wait)`;
      const bad = extra(s, actFields);
      if (bad.length) return `${at}: у act нет полей ${bad.join(", ")}`;
      out.push({ kind: "act", input: s });
    }
  }
  return out;
}

const brief = (s: Step): string => {
  if (s.kind === "wait") return `wait ${s.ms} мс`;
  if (s.kind === "capture") return "capture";
  const t = s.input.target;
  const what = typeof t === "string" ? t : isObj(t) ? String(t.text ?? t.role ?? (t.handle !== undefined ? `handle ${String(t.handle)}` : `${String(t.x)},${String(t.y)}`)) : "";
  return `act ${String(s.input.do ?? "click")}${what ? ` «${what.slice(0, 40)}»` : ""}`;
};

/** Вход шага act: общий app сверху; промежуточный шаг без verify — без снимков до/после (если модель не решила сама). */
function actInput(s: Record<string, unknown>, app: unknown, last: boolean): Record<string, unknown> {
  const quiet = !last && s.verify === undefined && s.observe === undefined;
  return { ...(app !== undefined && s.app === undefined ? { app } : {}), ...s, ...(quiet ? { observe: false } : {}) };
}

export async function actSteps(ctx: ToolContext, input: Record<string, unknown>, dispatch: DispatchFn): Promise<ToolResult> {
  const steps = parseSteps(input);
  if (typeof steps === "string") return err(`act{steps}: ${steps}. Ничего не сделано.`);
  const deadline = Date.now() + SERIES_BUDGET_MS;
  const done: StepRecord[] = [];
  let stop: StopReason | null = null;
  let idle = 0;
  for (const [i, s] of steps.entries()) {
    if (ctx.isCancelled?.()) stop = "cancelled";
    else if (Date.now() > deadline) stop = "budget";
    if (stop) break;
    const label = `${i + 1}/${steps.length} ${brief(s)}`;
    if (s.kind === "wait") {
      await sleep(s.ms);
      idle += s.ms;
      done.push({ label, r: { content: `пауза ${s.ms} мс`, isError: false }, mutate: false, capture: false });
      continue;
    }
    const r =
      s.kind === "capture"
        ? await dispatch("screen_capture", s.input, ctx)
        : await dispatch("act", actInput(s.input, input.app, i === steps.length - 1), ctx);
    done.push({ label, r, mutate: s.kind === "act" && toolCallEffect("act", s.input) === "mutate", capture: s.kind === "capture" });
    stop = stopReasonOf(r);
    if (stop) break;
  }
  return seriesResult(done, steps.length, stop, idle);
}

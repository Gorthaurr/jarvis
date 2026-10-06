/**
 * Ход лаб-клиента: когда он закончился и что в нём произошло. Всё выводится из журнала событий (recorder) после метки
 * отправки реплики — поэтому чужие кадры (онбординг полной сессии, проактив) до метки в ход не попадают.
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { TurnResult } from "./contracts.js";
import { answerOf } from "./policy.js";
import type { EventRecorder, LabEvent } from "./recorder.js";

const TERMINAL = new Set(["done", "failed", "cancelled"]);
/** Нет ни thinking, ни speaking (управляющая фраза перехвачена до агента), но что-то пришло и стихло на столько — ход закончен. */
const NO_START_QUIET_MS = 1500;
/** После idle ждём: не стартует ли фоновая задача (task.status приходит сразу за promote). */
const TASK_GRACE_MS = 400;
/** После терминала последней задачи — хвост: итог задачи приходит отдельным chat. */
const TASK_TAIL_MS = 500;

type Obj = Record<string, unknown>;
const p = (e: LabEvent): Obj => (e.payload && typeof e.payload === "object" ? (e.payload as Obj) : {});
const inOf = (evs: LabEvent[], type: string): LabEvent[] => evs.filter((e) => e.dir === "in" && e.type === type);

/** Последнее состояние каждой задачи хода (порядок — по первому появлению). */
export function taskStates(evs: LabEvent[]): Array<{ taskId: string; state: string; title?: string }> {
  const m = new Map<string, { taskId: string; state: string; title?: string }>();
  for (const e of inOf(evs, "task.status")) {
    const t = p(e);
    const id = String(t.taskId ?? "");
    const prev = m.get(id);
    const title = typeof t.title === "string" ? t.title : prev?.title;
    m.set(id, { taskId: id, state: String(t.state ?? ""), ...(title ? { title } : {}) });
  }
  return [...m.values()];
}

/** Решить, закончен ли ход, по событиям после метки. `null` — ещё нет. Чистая функция (время передаётся). */
export function judgeEnd(evs: LabEvent[], now: number, waitTasks: boolean): "idle" | "task_done" | null {
  const activity = evs.filter((e) => e.dir === "in" && e.type !== "ping");
  const states = inOf(evs, "client.state").map((e) => ({ s: String(p(e).state), at: e.at }));
  const startAt = states.findIndex((x) => x.s === "thinking" || x.s === "speaking");
  if (startAt < 0) {
    const last = activity[activity.length - 1];
    return last && now - last.at >= NO_START_QUIET_MS ? "idle" : null;
  }
  const idle = states.slice(startAt + 1).find((x) => x.s === "idle");
  if (!idle) return null;
  if (!waitTasks) return "idle";
  const tasks = taskStates(evs);
  if (tasks.length === 0) return now - idle.at >= TASK_GRACE_MS ? "idle" : null;
  if (tasks.some((t) => !TERMINAL.has(t.state))) return null;
  const lastAt = activity[activity.length - 1]?.at ?? idle.at;
  return now - lastAt >= TASK_TAIL_MS ? "task_done" : null;
}

/** Ждать конца хода: пересчёт на каждое событие и по таймеру (условия «стихло» зависят от времени). */
export function waitTurnEnd(rec: EventRecorder, mark: number, o: { timeoutMs: number; waitTasks: boolean }): Promise<"idle" | "task_done" | "timeout"> {
  return new Promise((resolve) => {
    const finish = (r: "idle" | "task_done" | "timeout"): void => {
      clearInterval(tick);
      clearTimeout(limit);
      off();
      resolve(r);
    };
    const check = (): void => {
      const r = judgeEnd(rec.since(mark), Date.now(), o.waitTasks);
      if (r) finish(r);
    };
    const off = rec.subscribe(check);
    const tick = setInterval(check, 100);
    const limit = setTimeout(() => finish("timeout"), o.timeoutMs);
    check();
  });
}

/** Собрать TurnResult из событий хода. */
export function buildTurn(utterance: string, evs: LabEvent[], startedAt: number, ended: TurnResult["ended"]): TurnResult {
  const chat = inOf(evs, "chat").map((e) => ({ role: p(e).role === "user" ? ("user" as const) : ("assistant" as const), text: String(p(e).text ?? ""), at: e.at }));
  const finals = inOf(evs, "transcript").filter((e) => p(e).final === true).map((e) => String(p(e).text ?? ""));
  const assistant = chat.filter((c) => c.role === "assistant");
  const chunks = inOf(evs, "speak.chunk");
  const first = chunks[0] ? p(chunks[0]) : undefined;
  const results = new Map<string, LabEvent>();
  for (const e of evs) if (e.dir === "out" && e.type === "action.result") results.set(String(p(e).commandId), e);
  const requests = new Map<string, Obj>();
  for (const e of inOf(evs, "user.confirm.request")) requests.set(String(p(e).requestId), p(e));
  const serverErrors = inOf(evs, "error").map((e) => `${String(p(e).code ?? "?")}: ${String(p(e).message ?? "")}`);
  return {
    utterance,
    ok: ended !== "timeout" && serverErrors.length === 0,
    ended,
    ms: Date.now() - startedAt,
    chat,
    answer: assistant[assistant.length - 1]?.text ?? finals[finals.length - 1] ?? "",
    speech: {
      chunks: chunks.length,
      bytes: chunks.reduce((n, e) => n + Number(p(e).audioBytes ?? 0), 0),
      ...(first ? { audioMime: first.format === "pcm16" ? `audio/pcm16;rate=${String(first.sampleRate ?? "")}` : "audio/mpeg" } : {}),
    },
    actions: inOf(evs, "action.command").flatMap((e) => {
      const r = results.get(e.id ?? "");
      return r ? [{ cmd: p(e) as unknown as ActionCommand, result: p(r) as unknown as ActionResult, ms: r.at - e.at }] : [];
    }),
    confirms: evs.filter((e) => e.dir === "out" && e.type === "user.confirm.result").map((e) => {
      const r = p(e);
      const q = requests.get(String(r.requestId)) ?? {};
      return { summary: String(q.summary ?? ""), kind: String(q.kind ?? ""), answer: answerOf({ approved: r.approved === true, outcome: r.outcome as never }) };
    }),
    tasks: taskStates(evs),
    cards: inOf(evs, "ui.display").map((e) => ({ ...(typeof p(e).title === "string" ? { title: String(p(e).title) } : {}), markdown: String(p(e).markdown ?? "") })),
    states: inOf(evs, "client.state").map((e) => String(p(e).state)),
    serverErrors,
  };
}

/**
 * После hello полная (не dev) сессия сама шлёт онбординг (~800 мс + озвучка). Ждём `settleMs` и затем тишину 300 мс
 * (не дольше +2,5 с), чтобы приветствие не попало в первый ход. Возвращает, сколько событий пришло за время ожидания.
 */
export async function settleSession(rec: EventRecorder, settleMs: number): Promise<number> {
  if (settleMs <= 0) return 0;
  const mark = rec.length;
  await new Promise((r) => setTimeout(r, settleMs));
  const until = Date.now() + 2_500;
  const lastIn = (): number => rec.since(mark).filter((e) => e.dir === "in" && e.type !== "ping").pop()?.at ?? 0;
  while (Date.now() < until && Date.now() - lastIn() < 300) await new Promise((r) => setTimeout(r, 50));
  return rec.length - mark;
}

/**
 * Сборка TurnResult из СЫРЫХ событий LabClient (events()) за окно одного голосового хода. Текстовый say() клиента этого не
 * умеет: голосовой ход не имеет одного «конца» — он идёт по client.state и озвучке. Поле `transcript` результата стенда —
 * это chat{role:"user"} (что распознал STT сервера), а НЕ сообщение `transcript` (оно — текст ОТВЕТА ассистента, карта §4.2).
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { LabClient, TurnResult } from "../lib/contracts.js";

export type LabEvent = ReturnType<LabClient["events"]>[number];

const P = (e: LabEvent): Record<string, unknown> => (e.payload && typeof e.payload === "object" ? (e.payload as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Что распознал STT сервера: реплики владельца (chat role=user) за окно. */
export function recognized(evs: LabEvent[]): string {
  return evs
    .filter((e) => e.dir === "in" && e.type === "chat" && P(e).role === "user")
    .map((e) => str(P(e).text))
    .join(" ")
    .trim();
}

export interface SpeechSummary {
  chunks: number;
  bytes: number;
  audioMime?: string;
}

export function buildTurn(utterance: string, evs: LabEvent[], meta: { ms: number; ended: TurnResult["ended"]; speech: SpeechSummary }): TurnResult {
  const inn = evs.filter((e) => e.dir === "in");
  const out = evs.filter((e) => e.dir === "out");
  const chat = inn.filter((e) => e.type === "chat").map((e) => ({ role: (P(e).role === "user" ? "user" : "assistant") as "user" | "assistant", text: str(P(e).text), at: e.at }));
  const finals = inn.filter((e) => e.type === "transcript" && P(e).final === true).map((e) => str(P(e).text));
  const answer = [...chat].reverse().find((c) => c.role === "assistant")?.text ?? finals[finals.length - 1] ?? "";

  const results = out.filter((e) => e.type === "action.result").map((e) => ({ r: e.payload as ActionResult, at: e.at }));
  const actions: TurnResult["actions"] = [];
  for (const c of inn.filter((e) => e.type === "action.command")) {
    const id = (c as { id?: string }).id;
    const i = results.findIndex((x) => (id ? x.r.commandId === id : true));
    const hit = i >= 0 ? results.splice(i, 1)[0] : undefined;
    if (hit) actions.push({ cmd: c.payload as ActionCommand, result: hit.r, ms: Math.max(0, hit.at - c.at) });
  }

  const answers = new Map(out.filter((e) => e.type === "user.confirm.result").map((e) => [str(P(e).requestId), P(e).approved === true ? "yes" : "no"]));
  const confirms = inn
    .filter((e) => e.type === "user.confirm.request")
    .map((e) => ({ summary: str(P(e).summary), kind: str(P(e).kind), answer: answers.get(str(P(e).requestId)) ?? "none" }));

  const tasks = new Map<string, { taskId: string; state: string; title?: string }>();
  for (const e of inn.filter((x) => x.type === "task.status")) {
    const p = P(e);
    const title = str(p.title) || tasks.get(str(p.taskId))?.title;
    tasks.set(str(p.taskId), { taskId: str(p.taskId), state: str(p.state), ...(title ? { title } : {}) });
  }

  const serverErrors = inn.filter((e) => e.type === "error").map((e) => `${str(P(e).code)}: ${str(P(e).message)}`);
  return {
    utterance,
    ok: meta.ended !== "timeout" && serverErrors.length === 0,
    ended: meta.ended,
    ms: meta.ms,
    chat,
    answer,
    speech: meta.speech,
    actions,
    confirms,
    tasks: [...tasks.values()],
    cards: inn.filter((e) => e.type === "ui.display").map((e) => ({ ...(str(P(e).title) ? { title: str(P(e).title) } : {}), markdown: str(P(e).markdown) })),
    states: inn.filter((e) => e.type === "client.state").map((e) => str(P(e).state)),
    serverErrors,
  };
}

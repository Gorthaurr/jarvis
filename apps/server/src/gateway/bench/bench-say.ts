/**
 * Стенд: POST /dev/bench/say — реплика через НАСТОЯЩУЮ петлю (onDevText → handleUserText → фон/финал) со сценарным
 * мозгом. Ждём, пока сессия не простаивает (фоновые задачи и §20-задачи дошли до терминала), и отдаём финальную
 * реплику, раунды модели (что петля ей показала: результаты инструментов, нуджи), §14-вопросы и журнал задачи.
 * `llm.loopCalls == 0` — реплику закрыл tier0/кэш без модели: сценарий обязан считать это провалом.
 */
import { onDevText } from "../router-ws.js";
import type { BenchHub } from "./bench-hub.js";
import { serializeTask } from "./bench-result.js";
import { newBenchCall, parsePolicy } from "./bench-socket.js";
import { type BenchReply, bad, numIn, waitExt } from "./bench-tool.js";
import { ScriptedLlm, parseScript } from "./scripted-llm.js";

const SETTLE_MS = 150;

export async function runSay(hub: BenchHub, body: Record<string, unknown>): Promise<BenchReply> {
  const text = String(body.text ?? "").trim();
  if (!text) return bad(400, "нужен text (реплика владельца)");
  const turns = parseScript(body.script);
  if (typeof turns === "string") return bad(400, turns);
  const policy = parsePolicy(body.confirm);
  if (!policy) return bad(400, "confirm: yes|no|expire|undelivered или их массив");
  const timeoutMs = numIn(body.timeoutMs, 1_000, 600_000, 120_000);
  const withSkills = (body.deps as { skills?: unknown } | undefined)?.skills === true;
  const ctx = await hub.ctx();
  const ext = await waitExt(hub.deps.brain.extBridge, numIn(body.waitExtMs, 0, 30_000, 5_000));
  const llm = new ScriptedLlm(turns);
  const call = newBenchCall(policy);
  const out = await hub.run(call, async () => {
    const deps = ctx.agentDeps;
    const prev = { llm: deps.llm, skills: deps.skills };
    deps.llm = llm;
    if (!withSkills) deps.skills = undefined;
    try {
      await onDevText(ctx, { text });
      const left = timeoutMs - (Date.now() - call.startedAt);
      if (await hub.waitIdle(ctx, left)) {
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        return { timedOut: false };
      }
      hub.deps.brain.tasks.cancelSession(ctx.session.sessionId);
      await hub.waitIdle(ctx, 5_000);
      return { timedOut: true };
    } finally {
      deps.llm = prev.llm;
      deps.skills = prev.skills;
    }
  });
  if (out === "busy") return bad(409, "стенд занят другим вызовом");
  const chat = call.frames.filter((f) => f.type === "chat").map((f) => f.payload as { role?: string; text?: string });
  const final = [...chat].reverse().find((c) => c.role === "assistant")?.text ?? null;
  const task = hub.lastTask(ctx, call.startedAt);
  return {
    code: 200,
    body: {
      ok: true,
      ms: Date.now() - call.startedAt,
      timedOut: out.timedOut,
      final,
      chat,
      rounds: llm.rounds,
      llm: llm.summary(),
      questions: call.questions,
      policyOverflow: call.questions.some((q) => q.overflow === true),
      stray: hub.stray(),
      clientActions: call.clientActions,
      frames: call.frames.filter((f) => f.type !== "chat").map((f) => ({ type: f.type, atMs: f.atMs })),
      task: task ? serializeTask(task) : null,
      ext,
      session: { id: ctx.session.sessionId, dev: ctx.agentDeps.devSession === true },
    },
  };
}

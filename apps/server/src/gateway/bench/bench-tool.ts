/**
 * Стенд: POST /dev/bench/tool — вызов инструмента через НАСТОЯЩИЙ dispatchTool в bench-сессии с живым расширением.
 * Ответ = ToolResult + заданные владельцу §14-вопросы (и ответы на них по политике вызова). `ok:false` — только
 * транспорт/ввод (занято, неразрешённый $ref, мусор); успех САМОГО инструмента — `result.isError`.
 */
import { makeToolCtx } from "../../brain/agent/loop/tool-ctx.js";
import { dispatchTool } from "../../brain/tools/dispatch.js";
import type { ExtensionBridge } from "../extension-bridge.js";
import type { BenchHub } from "./bench-hub.js";
import { serializeToolResult } from "./bench-result.js";
import { newBenchCall, parsePolicy } from "./bench-socket.js";
import { isInspectText, resolvePlaceholders } from "./script-refs.js";

export interface BenchReply {
  code: number;
  body: Record<string, unknown>;
}

export const bad = (code: number, error: string, extra: Record<string, unknown> = {}): BenchReply => ({ code, body: { ok: false, error, ...extra } });

export function numIn(raw: unknown, min: number, max: number, dflt: number): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

/** MV3 service worker засыпает и переподключается — ждём коннекта расширения до `ms`. */
export async function waitExt(ext: Pick<ExtensionBridge, "connected">, ms: number): Promise<{ connected: boolean; waitedMs: number }> {
  const t0 = Date.now();
  while (!ext.connected && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  return { connected: ext.connected, waitedMs: Date.now() - t0 };
}

export async function runTool(hub: BenchHub, body: Record<string, unknown>): Promise<BenchReply> {
  const name = String(body.name ?? "").trim();
  if (!name) return bad(400, "нужен name (имя инструмента)");
  const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? (body.input as Record<string, unknown>) : {};
  const policy = parsePolicy(body.confirm);
  if (!policy) return bad(400, "confirm: yes|no|expire|undelivered или их массив");
  const ctx = await hub.ctx();
  const ext = await waitExt(hub.deps.brain.extBridge, numIn(body.waitExtMs, 0, 30_000, 5_000));
  const r = resolvePlaceholders(input, hub.lastInspectText, hub.lastResultText);
  if (r.unresolved.length) return bad(400, "плейсхолдеры не разрешены — инструмент НЕ вызван", { unresolved: r.unresolved });
  const call = newBenchCall(policy);
  const out = await hub.run(call, () => dispatchTool(name, r.value, makeToolCtx(ctx.agentDeps, ctx.session, undefined)));
  if (out === "busy") return bad(409, "стенд занят другим вызовом");
  const result = serializeToolResult(out);
  if (isInspectText(result.text)) hub.lastInspectText = result.text;
  hub.lastResultText = result.text;
  return {
    code: 200,
    body: {
      ok: true,
      ms: Date.now() - call.startedAt,
      result,
      questions: call.questions,
      policyOverflow: call.questions.some((q) => q.overflow === true),
      resolved: r.resolved,
      clientActions: call.clientActions,
      ext,
      session: { id: ctx.session.sessionId, dev: ctx.agentDeps.devSession === true },
    },
  };
}

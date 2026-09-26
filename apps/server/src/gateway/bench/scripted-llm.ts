/**
 * Стенд: СЦЕНАРНЫЙ «мозг» для /dev/bench/say — проводит НАСТОЯЩУЮ петлю handleUserText по заданной последовательности
 * ходов модели (tool_use с входами → … → финальный текст). Подключается только в bench-сессии (agentDeps.llm).
 *
 * Вызов ПЕТЛИ отличается от побочного по `sessionKey` (петля шлёт его всегда, model-call.ts): побочным (рефлексы,
 * prefill навыка, противоречия memory_write) — честный стаб, скрипт они не съедают. Скрипт кончился, а петля зовёт
 * ещё (нудж verify/goal-check) — тоже стаб + `exhausted`: терминал H2 честный, «Готово» за модель не выдумываем.
 */
import { type ILlmProvider, type LlmDelta, type LlmMessage, type LlmRequest, type LlmResponse, type StopReason, streamViaComplete } from "../../integrations/llm.js";
import { isInspectText, resolvePlaceholders, toolResultTexts } from "./script-refs.js";

export interface ScriptTurn {
  text?: string;
  tool_uses?: Array<{ name: string; input?: Record<string, unknown> }>;
  stop_reason?: StopReason;
}

export interface ScriptRound {
  i: number;
  /** Текст user-хода без tool_result (нудж verify/goal-check, служебная врезка); на первом раунде — реплика. */
  userText: string | null;
  toolResults: Array<{ text: string; isError: boolean }>;
  reply: { text: string; toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> } | null;
  unresolved: string[];
}

const MAX_TURNS = 40;
const MAX_TOOL_USES = 8;
const RESULT_CAP = 4000;
let instanceSeq = 0;

/** Разобрать сценарий {turns:[…]} | […]. Ошибка → строка. */
export function parseScript(raw: unknown): ScriptTurn[] | string {
  const turns = Array.isArray(raw) ? raw : (raw as { turns?: unknown } | undefined)?.turns;
  if (!Array.isArray(turns) || turns.length === 0) return "script.turns: нужен непустой массив ходов";
  if (turns.length > MAX_TURNS) return `script.turns: не больше ${MAX_TURNS} ходов`;
  for (const [i, t] of turns.entries()) {
    if (!t || typeof t !== "object") return `ход ${i}: не объект`;
    const uses = (t as ScriptTurn).tool_uses ?? [];
    if (!Array.isArray(uses) || uses.length > MAX_TOOL_USES) return `ход ${i}: tool_uses — массив до ${MAX_TOOL_USES}`;
    if (uses.some((u) => !u || typeof u.name !== "string" || !u.name)) return `ход ${i}: у tool_use нет name`;
    const text = (t as ScriptTurn).text;
    if (text !== undefined && typeof text !== "string") return `ход ${i}: text — строка`;
  }
  return turns as ScriptTurn[];
}

function stub(): LlmResponse {
  return { text: "", toolUses: [], stopReason: "stub", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, stubbed: true };
}

function lastUser(messages: LlmMessage[]): { userText: string | null; toolResults: ScriptRound["toolResults"] } {
  const m = [...messages].reverse().find((x) => x.role === "user");
  if (!m) return { userText: null, toolResults: [] };
  if (typeof m.content === "string") return { userText: m.content.slice(0, 1000), toolResults: [] };
  const texts: string[] = [];
  const toolResults: ScriptRound["toolResults"] = [];
  for (const b of m.content) {
    if (b.type === "text") texts.push(b.text);
    if (b.type === "tool_result") {
      const t = typeof b.content === "string" ? b.content : b.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
      toolResults.push({ text: t.slice(0, RESULT_CAP), isError: b.is_error === true });
    }
  }
  return { userText: texts.length ? texts.join("\n").slice(0, 1000) : null, toolResults };
}

export class ScriptedLlm implements ILlmProvider {
  readonly live = true;
  loopCalls = 0;
  sideCalls = 0;
  extraLoopCalls = 0;
  exhausted = false;
  readonly rounds: ScriptRound[] = [];
  private next = 0;
  private readonly seq = ++instanceSeq;

  constructor(private readonly turns: ScriptTurn[]) {}

  get scriptTurns(): number {
    return this.turns.length;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!req.sessionKey) {
      this.sideCalls += 1;
      return stub();
    }
    this.loopCalls += 1;
    const round: ScriptRound = { i: this.rounds.length, ...lastUser(req.messages), reply: null, unresolved: [] };
    this.rounds.push(round);
    const turn = this.turns[this.next];
    if (!turn) {
      this.exhausted = true;
      this.extraLoopCalls += 1;
      return stub();
    }
    this.next += 1;
    const results = toolResultTexts(req.messages);
    const inspects = [...results].reverse().filter(isInspectText);
    const last = results[results.length - 1] ?? "";
    const toolUses = (turn.tool_uses ?? []).map((u, j) => {
      const r = resolvePlaceholders(u.input ?? {}, inspects, last);
      round.unresolved.push(...r.unresolved);
      return { id: `toolu_bench_${this.seq}_${round.i}_${j}`, name: u.name, input: r.value };
    });
    const text = turn.text ?? "";
    round.reply = { text, toolUses };
    return {
      text,
      toolUses,
      stopReason: turn.stop_reason ?? (toolUses.length ? "tool_use" : "end_turn"),
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stubbed: false,
      channel: "primary",
      modelUsed: "bench-script",
    };
  }

  completeStream(req: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
    return streamViaComplete(this, req, onDelta);
  }

  release(): void {}

  summary(): { loopCalls: number; sideCalls: number; scriptTurns: number; exhausted: boolean; extraLoopCalls: number } {
    return { loopCalls: this.loopCalls, sideCalls: this.sideCalls, scriptTurns: this.turns.length, exhausted: this.exhausted, extraLoopCalls: this.extraLoopCalls };
  }
}

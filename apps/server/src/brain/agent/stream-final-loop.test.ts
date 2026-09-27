/**
 * W3 (V-4 = B-F7): финал РАЗГОВОРНОГО хода после инструментов звучит по мере генерации, а не целиком из терминала.
 * ПЕТЛЁЙ (handleUserText + настоящий dispatchTool): «какая погода?» → web_search → ответ. Провайдер модели —
 * ручной: шаг 1 отдаёт дельты и ДЕРЖИТ промис, пока тест не отпустит, — так видно, звучит ли фраза до конца вызова.
 * Реверт-проверки (из копии): стрим только на `step === 0` (stream-final.ts) — падает первый кейс; без предиката
 * finalStreamSafe — второй; без глушения капитуляции в первой отдаче — третий; `step === 0` вместо streamedThisRound
 * в докрутке max_tokens — четвёртый.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import type { ILlmProvider, LlmDelta, LlmRequest, LlmResponse, StopReason, ToolUse } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, type ReplySink, handleUserText } from "./index.js";

type Turn = (onDelta: (d: LlmDelta) => void) => Promise<LlmResponse>;
const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };
const resp = (text: string, toolUses: ToolUse[] = [], stopReason?: StopReason): LlmResponse => ({
  text, toolUses, stopReason: stopReason ?? (toolUses.length > 0 ? "tool_use" : "end_turn"), usage: USAGE, stubbed: true,
});
const toolTurn = (id: string, name: string, input: Record<string, unknown>): Turn => async () => resp("", [{ id, name, input }]);
/** Текстовый ход дельтами; `hold` — после скольких дельт ждать отпускания (промис хода висит). */
const textTurn = (parts: string[], opts: { hold?: { after: number; gate: Promise<void> }; stopReason?: StopReason } = {}): Turn => async (onDelta) => {
  for (let i = 0; i < parts.length; i += 1) {
    if (opts.hold && i === opts.hold.after) await opts.hold.gate;
    onDelta({ text: parts[i] as string });
  }
  return resp(parts.join(""), [], opts.stopReason);
};

/** Провайдер-сценарий: complete = тот же ход без слушателя дельт. Помнит, сколько фраз прозвучало к каждому вызову. */
class ScriptLlm implements ILlmProvider {
  readonly live = false;
  readonly requests: LlmRequest[] = [];
  readonly spokenAtCall: number[] = [];
  /** Снимок истории на момент вызова (convo — один массив, петля дописывает его дальше). */
  readonly seen: string[] = [];
  resolved = 0;
  private i = 0;
  constructor(private readonly turns: Turn[], private readonly spoken: () => number) {}
  complete(req: LlmRequest): Promise<LlmResponse> {
    return this.completeStream(req, () => {});
  }
  async completeStream(req: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
    this.requests.push(req);
    this.spokenAtCall.push(this.spoken());
    this.seen.push(JSON.stringify(req.messages));
    const turn = this.turns[this.i] ?? (async () => resp("Готово."));
    this.i += 1;
    const r = await turn(onDelta);
    this.resolved += 1;
    return r;
  }
}

function harness(turns: (spoken: () => number) => Turn[]) {
  const sentences: string[] = [];
  const done: string[] = [];
  const sink: ReplySink = { sentence: (s) => sentences.push(s), display: () => {}, done: (full) => done.push(full) };
  const llm = new ScriptLlm(turns(() => sentences.length), () => sentences.length);
  const deps: AgentDeps = {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider([{ title: "Погода", url: "https://example.org/w", snippet: "плюс пять" }]),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
  };
  const sendAction = vi.fn(async (cmd: ActionCommand) =>
    cmd.kind === "gui.act"
      ? { commandId: "c", ok: true, durationMs: 1, data: { found: { via: "snapshot", name: "Обновить" }, did: "UIA invoke", verified: "unchecked", detail: "…" } }
      : { commandId: "c", ok: true, durationMs: 1 },
  );
  const session = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
  return { sentences, done, sink, llm, deps, session };
}

const QUESTION = "какая сейчас погода в москве?";
const PHRASES = ["В Москве плюс пять градусов. ", "Ветер слабый, северный. ", "Осадков не ждут."];

describe("W3 V-4: финал разговорного хода после инструментов — стримом", () => {
  it("фраза 1 шага 1 звучит ДО того, как вызов модели разрешился; фраз ровно три, done один", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(() => [toolTurn("s1", "web_search", { query: "погода москва" }), textTurn(PHRASES, { hold: { after: 2, gate } })]);
    const run = handleUserText(h.session, QUESTION, h.deps, h.sink);
    try {
      await vi.waitFor(() => expect(h.sentences.length).toBeGreaterThanOrEqual(1), { timeout: 3000, interval: 5 });
      expect(h.llm.resolved).toBe(1); // шаг 1 ещё генерирует — а первая фраза уже в голосе
      expect(h.sentences[0]).toMatch(/плюс пять/u);
    } finally {
      release();
    }
    const reply = await run;
    expect(h.sentences).toHaveLength(3); // терминал не продублировал застримленный финал
    expect(h.sentences.filter((s) => /плюс пять/u.test(s))).toHaveLength(1);
    expect(h.done).toHaveLength(1);
    expect(h.done[0]).toBe(reply.voice);
  });

  it("ход с делом (act, долг сверки): из шага 1 до verify-нуджа в голос не уходит НИЧЕГО, итог звучит один раз", async () => {
    const claim = "Готово, сэр — обновил прогноз.";
    const h = harness(() => [toolTurn("a1", "act", { target: "Обновить" }), textTurn([claim]), textTurn([claim]), textTurn([claim])]);
    await handleUserText(h.session, QUESTION, h.deps, h.sink);
    const nudgeAt = h.llm.seen.findIndex((m) => m.includes("НЕ проверил исход"));
    expect(nudgeAt).toBeGreaterThan(0); // verify-нудж был
    expect(h.llm.spokenAtCall[nudgeAt]).toBe(0); // к нуджу из шага 1 не прозвучало ни фразы
    expect(h.sentences.filter((s) => s.includes("обновил прогноз"))).toHaveLength(1);
  });

  it("первая фраза — капитуляция: не звучит; после переспроса ответ звучит ровно один раз", async () => {
    const h = harness(() => [
      toolTurn("s1", "web_search", { query: "погода москва" }),
      textTurn(["Не могу найти точный прогноз. ", "Попробуйте позже."]),
      textTurn(PHRASES),
    ]);
    await handleUserText(h.session, QUESTION, h.deps, h.sink);
    expect(h.sentences.join(" ")).not.toMatch(/Не могу|позже/u);
    expect(h.sentences.filter((s) => /плюс пять/u.test(s))).toHaveLength(1);
    expect(h.llm.requests).toHaveLength(3); // анти-капитуляция переспросила
  });

  it("ответ по делу с оговоркой «не могу» в хвосте — уже звучит, анти-капитуляция не переспрашивает (второго голоса нет)", async () => {
    const h = harness(() => [
      toolTurn("s1", "web_search", { query: "погода москва" }),
      textTurn(["В Москве плюс пять градусов. ", "Точнее по району, к сожалению, не могу сказать."]),
      textTurn(["Готово, повторяю: плюс пять."]),
    ]);
    await handleUserText(h.session, QUESTION, h.deps, h.sink);
    expect(h.llm.requests).toHaveLength(2);
    expect(h.sentences).toHaveLength(2);
    expect(h.sentences.join(" ")).not.toMatch(/повторяю/u);
  });

  it("max_tokens на застримленном шаге > 0 — докрутки нет (сказанное не повторяем)", async () => {
    const h = harness(() => [toolTurn("s1", "web_search", { query: "погода москва" }), textTurn(["В Москве плюс пять градусов. ", "Ветер"], { stopReason: "max_tokens" })]);
    await handleUserText(h.session, QUESTION, h.deps, h.sink);
    expect(h.llm.requests).toHaveLength(2);
    expect(h.llm.seen.join("")).not.toMatch(/Продолжай ровно с места обрыва/u);
    expect(h.sentences.filter((s) => /плюс пять/u.test(s))).toHaveLength(1);
  });
});

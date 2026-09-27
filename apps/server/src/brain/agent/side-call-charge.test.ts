/**
 * C6 (аудит прод-логов 27.09): фантомные доллары в SpendGuard. Правило «ход по ПОДПИСКЕ = $0» жило только в
 * accountRound петли, а побочные LLM-вызовы — рефлексы памяти и обязательств, самообучение, сон-цикл, префилл
 * реплея — списывали цену API за вызов, который на деле ушёл по подписке (консолидация 25.09: +$0.02 при нуле
 * реальных трат). Каждый кейс гоняет НАСТОЯЩУЮ функцию места вызова с настоящим SpendGuard и смотрит на
 * наблюдаемый исход — траты периода. Контроль «по API → деньги списаны» доказывает, что учёт вообще проведён
 * (ноль не получается даром из-за того, что recordUsage не зовётся).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, SkillStep } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { type ILlmProvider, type LlmRequest, type LlmResponse, streamViaComplete } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import type { SkillProvider } from "../../memory/skills.js";
import { WorkingMemory } from "../../memory/working.js";
import { consolidateMemory } from "../../proactive/consolidation.js";
import { reflectCommitmentFromUtterance } from "./commitment-reflect.js";
import { type AgentDeps, type UsageSinkEvent, handleUserText } from "./index.js";
import { selfLearnSkill } from "./loop/self-learn.js";
import { reflectFactFromUtterance } from "./memory-reflect.js";

type Channel = LlmResponse["channel"];
const MODEL = "claude-opus-5"; // реальный id каталога — реальный тариф
/** Вызов консолидации 25.09 из лога: in 2 / cacheCreate 2961 / out 1 — по тарифу Opus ≈ $0.02. */
const USAGE = { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 2961 };

/** LLM, отвечающий заданными текстами по порядку; канал проставлен, как его ставит фолбэк-цепочка. */
function llmVia(channel: Channel, texts: string[] = ["[]"]): ILlmProvider {
  let i = 0;
  const self: ILlmProvider = {
    live: true,
    complete: async (_req: LlmRequest): Promise<LlmResponse> => {
      const text = texts[Math.min(i++, texts.length - 1)] ?? "";
      return { text, toolUses: [], stopReason: "end_turn", usage: { ...USAGE }, stubbed: false, ...(channel ? { channel } : {}) };
    },
    completeStream: (req, onDelta) => streamViaComplete(self, req, onDelta),
  };
  return self;
}

beforeEach(() => {
  vi.stubEnv("JARVIS_MEMORY_REFLECT", "1");
  vi.stubEnv("JARVIS_MEMORY_REFLECT_CAP", "100");
  vi.stubEnv("JARVIS_COMMITMENT_REFLECT", "1");
  vi.stubEnv("JARVIS_COMMITMENT_REFLECT_CAP", "100");
});
afterEach(() => vi.unstubAllEnvs());

/** Места побочных вызовов: каждое получает LLM и SpendGuard, как в бою. */
const SITES: Record<string, (llm: ILlmProvider, spend: SpendGuard, user: string) => Promise<unknown>> = {
  "сон-цикл (consolidation)": (llm, spend, user) =>
    consolidateMemory({ llm, episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()), model: MODEL, spend }, user, {
      turns: [{ role: "user", text: "я обычно работаю по ночам" }],
    }),
  "рефлекс памяти (memory-reflect)": (llm, spend, user) =>
    reflectFactFromUtterance({ llm, model: MODEL, episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()), userId: user, utterance: "я работаю по ночам", spend }),
  "рефлекс обязательств (commitment-reflect)": (llm, spend, user) =>
    reflectCommitmentFromUtterance({ llm, model: MODEL, reminders: {} as never, sessionId: "s", userId: user, utterance: "завтра надо позвонить маме", spend }),
  "самообучение (self-learn)": (llm, spend, user) =>
    selfLearnSkill({
      deps: { llm, spend } as unknown as AgentDeps,
      sys: { staticPrefix: "П", dynamicSuffix: "" },
      convo: [{ role: "user", content: "сделай дело" }],
      finalText: "Сделал.",
      round: 3,
      toolTrajectory: [],
      toolCtx: {} as never,
      tier: "sonnet",
      model: MODEL,
      taskId: `t-${user}`,
      wasResearched: false,
    }),
};

describe("C6: побочные LLM-вызовы по подписке не списывают доллары API", () => {
  let n = 0;
  for (const [name, run] of Object.entries(SITES)) {
    it(`${name}: канал subscription → траты периода 0; канал API → списано`, async () => {
      const viaSub = new SpendGuard();
      await run(llmVia("subscription"), viaSub, `u-sub-${n++}`);
      expect(viaSub.totalSpent).toBe(0); // до фикса: ≈ $0.02–0.04 фантомных денег

      const viaApi = new SpendGuard();
      await run(llmVia("primary"), viaApi, `u-api-${n++}`);
      expect(viaApi.totalSpent).toBeGreaterThan(0.01); // контроль: учёт проведён, API тарифицируется
    });
  }

  it("самообучение: и метрика COGS (usageSink) видит $0 и канал subscription", async () => {
    const events: UsageSinkEvent[] = [];
    await selfLearnSkill({
      deps: { llm: llmVia("subscription"), spend: new SpendGuard(), usageSink: (e: UsageSinkEvent) => events.push(e) } as unknown as AgentDeps,
      sys: { staticPrefix: "П", dynamicSuffix: "" },
      convo: [{ role: "user", content: "сделай дело" }],
      finalText: "Сделал.",
      round: 3,
      toolTrajectory: [],
      toolCtx: {} as never,
      tier: "sonnet",
      model: MODEL,
      taskId: "t-sink",
      wasResearched: false,
    });
    expect(events.map((e) => [e.kind, e.costUsd, e.channel])).toEqual([["reflect", 0, "subscription"]]);
  });
});

/**
 * Префилл реплея — ПЕТЛЁЙ (`handleUserText`): между skill-prefill и admission лежит проводка канала (onUsage),
 * которой раньше не было вовсе — admission жёстко писал channel:"api" и цену API.
 */
describe("C6: префилл needsLlm-шагов реплея (admission ← skill-prefill)", () => {
  it("вся задача по подписке → SpendGuard 0, событие prefill — $0 и канал subscription", async () => {
    const events: UsageSinkEvent[] = [];
    const sendAction = vi.fn((_c: ActionCommand) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }));
    const session = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn() } as unknown as Session;
    const steps: SkillStep[] = [
      { action: "app.focus", params: { app: "telegram" } },
      { action: "input.type", needsLlm: true, params: {} },
      { action: "input.key", needsLlm: true, params: {} },
    ];
    const skills: SkillProvider = {
      list: async () => [],
      get: async () => null,
      save: async (_u, input) => ({ id: "saved", name: input.name, version: 1 }),
      recall: async () => ({ id: "learned__x", ownerId: "u1", name: "Написать в чат", when: "написать", procedure: "проза", version: 1, steps, needsReview: false, recallSim: 0.95 }),
    };
    const spend = new SpendGuard();
    const deps: AgentDeps = {
      memory: new WorkingMemory(),
      llm: llmVia("subscription", ['{"1": {"text": "gg wp"}, "2": {"combo": "enter"}}', "Сделал по процедуре, сэр."]),
      episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
      web: new MockWebProvider(),
      models: { haiku: "h", sonnet: MODEL, fable: "f" },
      spend,
      userId: "u1",
      skills,
      usageSink: (e) => events.push(e),
    };
    await handleUserText(session, "запусти поиск в доте", deps);
    const prefill = events.filter((e) => e.kind === "prefill");
    expect(prefill).toHaveLength(1); // префилл реально состоялся
    expect(prefill[0]?.costUsd).toBe(0); // до фикса: цена Opus за cache-write 2961
    expect(prefill[0]?.channel).toBe("subscription"); // до фикса: жёстко "api"
    expect(spend.totalSpent).toBe(0);
  });
});

/**
 * Ревью 2026-09-24 (T-F6/B-F1): промоушен sync-first — по ФАКТУ первого tool_use, а не по таймеру 1,5 с.
 *
 * Живой корень: раунд модели на подписке ≥2,9 с, таймер 1,5 с выигрывал всегда → «Берусь, сэр» на КАЖДОЕ
 * действие, в том числе на реплику, на которую модель просто ответила словами («нет, не надо» → «Берусь» +
 * ответ через 5 с). Проверяем ПЕТЛЁЙ (handleUserText → runActionSyncFirst → реальная петля) с медленной моделью.
 * Реверт-проверка (сделана): SYNC_PROMOTE_DEFAULT_MS=1_500 — падают первый (прозвучит ack) и второй; пустой
 * onToolRound (промоушен только по порогу) — падает второй (ack лишь через 6 с); ack без origin — тоже второй.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { sleep } from "@jarvis/shared";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { type LlmRequest, type LlmResponse, MockLlmProvider, type MockTurn } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

const ACK_RE = /Берусь|Сию минуту|Занимаюсь|Сейчас сделаю|Принял|Есть, сэр/u;

/** Модель «как на подписке»: каждый ответ приходит с задержкой. */
class SlowLlm extends MockLlmProvider {
  private n = 0;
  constructor(script: MockTurn[], private readonly delays: number[]) {
    super(script);
  }
  override async complete(req: LlmRequest): Promise<LlmResponse> {
    const d = this.delays[this.n] ?? 0;
    this.n += 1;
    if (d > 0) await sleep(d);
    return super.complete(req);
  }
}

function spySink() {
  const calls = { done: [] as Array<{ text: string; origin?: string }>, sentences: [] as string[] };
  const sink = {
    thinking: () => {},
    sentence: (s: string) => calls.sentences.push(s),
    display: () => {},
    done: (v: string, o?: { origin?: string }) => calls.done.push({ text: v, ...(o?.origin ? { origin: o.origin } : {}) }),
  };
  return { sink, calls };
}

function makeSession(sendAction = vi.fn((_c: ActionCommand) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }))) {
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}

function makeDeps(llm: MockLlmProvider, spoken: string[], memory = new WorkingMemory()): AgentDeps {
  return {
    memory,
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
    speakResult: (r) => spoken.push(r.voice),
    bgTasks: new Set(),
  };
}

async function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.JARVIS_SYNC_PROMOTE_MS;
  if (value === undefined) delete process.env.JARVIS_SYNC_PROMOTE_MS;
  else process.env.JARVIS_SYNC_PROMOTE_MS = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.JARVIS_SYNC_PROMOTE_MS;
    else process.env.JARVIS_SYNC_PROMOTE_MS = prev;
  }
}

describe("T-F6/B-F1: промоушен по факту tool_use, не по таймеру", () => {
  it("модель ответила ТЕКСТОМ через 1,8 с (дольше старого таймера) → ответ звучит сам, «Берусь» НЕ звучит", async () => {
    await withEnv(undefined, async () => {
      const spoken: string[] = [];
      const { sink, calls } = spySink();
      const llm = new SlowLlm([{ text: "Хорошо, сэр, оставляю всё как есть." }], [1_800]);
      await handleUserText(makeSession(), "сделай долгую многошаговую штуку", makeDeps(llm, spoken), sink);
      expect(calls.done).toHaveLength(1);
      expect(calls.done[0]?.text).toContain("оставляю всё как есть");
      expect(calls.done[0]?.text).not.toMatch(ACK_RE);
      expect(spoken).toHaveLength(0); // итог прозвучал этим ходом, не фоновой фразой позже
    });
  }, 8_000);

  it("модель пошла в инструмент через 1,7 с → ack СРАЗУ по tool_use (не ждём верхнего порога 6 с), он — проактив", async () => {
    await withEnv(undefined, async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const session = makeSession(vi.fn(() => gate.then(() => ({ commandId: "c", ok: true, durationMs: 1 }))));
      const spoken: string[] = [];
      const { sink, calls } = spySink();
      const llm = new SlowLlm(
        [{ toolUses: [{ id: "t1", name: "app_launch", input: { app: "x" } }] }, { text: "Готово, сэр." }],
        [1_700, 0],
      );
      const t0 = Date.now();
      const p = handleUserText(session, "сделай долгую многошаговую штуку", makeDeps(llm, spoken), sink);
      await vi.waitFor(() => expect(calls.done).toHaveLength(1), { timeout: 4_500, interval: 25 });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(1_650);
      expect(elapsed).toBeLessThan(4_500); // по tool_use, а не по порогу 6 с
      expect(calls.done[0]?.text).toMatch(ACK_RE);
      // Ack промоушена — ПРОАКТИВ: окно разговора он открывать не должен (пайплайн читает origin).
      expect(calls.done[0]?.origin).toBe("proactive");
      await p;
      release();
      await vi.waitFor(() => expect(spoken).toHaveLength(1), { timeout: 2_000 });
      expect(spoken[0]).toContain("Готово");
    });
  }, 10_000);

  it("модель думает дольше верхнего порога и инструмента нет → всё равно ack (не молчим вечно), итог — фоном", async () => {
    await withEnv("300", async () => {
      const spoken: string[] = [];
      const { sink, calls } = spySink();
      const llm = new SlowLlm([{ text: "Подумал и сделал вывод, сэр." }], [900]);
      const p = handleUserText(makeSession(), "сделай долгую многошаговую штуку", makeDeps(llm, spoken), sink);
      await vi.waitFor(() => expect(calls.done).toHaveLength(1), { timeout: 800, interval: 20 });
      expect(calls.done[0]?.text).toMatch(ACK_RE);
      await p;
      await vi.waitFor(() => expect(spoken).toHaveLength(1), { timeout: 2_000 });
      expect(spoken[0]).toContain("вывод");
      expect(calls.sentences).toHaveLength(0); // поздний ответ не просочился стримом поверх ack
    });
  }, 6_000);
});

describe("T-F6: согласие на ВОПРОС Джарвиса — подтверждение действия, а не болтовня", () => {
  it("«да» после «Открыть почту в фоне?» → задача-действие (sonnet), а не разговорный тир", async () => {
    // Реверт: убери confirmationAware в handleUserText — «да» уйдёт разговором (tier haiku, conversational).
    const memory = new WorkingMemory();
    memory.pushTurn("user", "что у меня в почте");
    memory.pushTurn("assistant", "Почта недоступна — вкладка не открыта. Открыть в фоне?");
    const llm = new MockLlmProvider([{ text: "Открываю почту в фоне, сэр." }]);
    const deps = makeDeps(llm, [], memory);
    delete deps.speakResult; // синхронный путь — проще читать запрос к модели
    await handleUserText(makeSession(), "да", deps);
    expect(llm.requests[0]?.tier).toBe("sonnet");
  });

  it("реакция «нет, не надо» НЕ берётся из кэша ответов (ответ зависит от того, на что она отвечает)", async () => {
    // Реверт: убери `!decision.reaction` из гейта кэша в handleUserText — прозвучит чужой кэшированный ответ.
    const llm = new MockLlmProvider([{ text: "Хорошо, сэр, не буду." }]);
    const lookup = vi.fn(async () => "Ответ из кэша на другую реплику.");
    const deps = makeDeps(llm, []);
    delete deps.speakResult;
    deps.responseCache = { lookup, store: vi.fn(async () => {}) } as unknown as AgentDeps["responseCache"];
    const reply = await handleUserText(makeSession(), "нет, не надо", deps);
    expect(lookup).not.toHaveBeenCalled();
    expect(reply.voice).toContain("не буду");
  });

  it("«да» без висящего вопроса — разговор (дешёвый тир)", async () => {
    const memory = new WorkingMemory();
    memory.pushTurn("assistant", "Готово, сэр.");
    const llm = new MockLlmProvider([{ text: "Рад стараться, сэр." }]);
    const deps = makeDeps(llm, [], memory);
    delete deps.speakResult;
    await handleUserText(makeSession(), "да", deps);
    expect(llm.requests[0]?.tier).toBe("haiku");
  });
});

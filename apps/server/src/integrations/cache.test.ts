/**
 * Тесты кеширования платных вызовов (§15): TtlCache + декораторы провайдеров
 * (эмбеддинги/web/TTS) + кеш-брейкпоинт agent-loop + съём cache-токенов Anthropic.
 */
import { describe, expect, it } from "vitest";
import { TtlCache } from "@jarvis/shared";
import type { LlmMessage } from "./llm.js";
import { markCacheBreakpoint } from "../brain/agent/index.js";
import { SessionWarmth } from "../brain/agent/warmth.js";
import { parseResponse } from "./anthropic.js";
import { CachingEmbeddingProvider, type IEmbeddingProvider } from "./openai-embeddings.js";
import { CachingWebProvider, type FetchedPage, type IWebProvider, type SearchHit } from "./web.js";
import { CachingTtsProvider } from "./tts-cache.js";
import { type ITtsProvider, MockTtsProvider, type TtsChunk, type TtsOpts, type TtsStream } from "./voice-providers.js";

// ── TtlCache ─────────────────────────────────────────────────

describe("TtlCache (§15)", () => {
  it("hit/miss и метрики", () => {
    const c = new TtlCache<number>({ ttlMs: 1e9 });
    c.set("a", 1);
    expect(c.get("a")).toBe(1); // hit
    expect(c.get("b")).toBeUndefined(); // miss
    expect(c.stats.hits).toBe(1);
    expect(c.stats.misses).toBe(1);
    expect(c.stats.hitRate).toBeCloseTo(0.5, 5);
  });

  it("TTL: запись истекает", () => {
    let t = 0;
    const c = new TtlCache<number>({ ttlMs: 100, now: () => t });
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
    t = 101;
    expect(c.get("a")).toBeUndefined();
  });

  it("LRU: вытеснение сверх maxEntries", () => {
    const c = new TtlCache<number>({ ttlMs: 1e9, maxEntries: 2 });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3); // вытесняет самый старый — "a"
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
  });
});

// ── эмбеддинги ───────────────────────────────────────────────

class CountingEmbed implements IEmbeddingProvider {
  readonly dim = 8;
  readonly live = true;
  calls = 0;
  constructor(private readonly ret: number[] | null = [1, 2, 3, 4, 5, 6, 7, 8]) {}
  async embed(_text: string): Promise<number[] | null> {
    this.calls += 1;
    return this.ret;
  }
}

describe("CachingEmbeddingProvider (§15)", () => {
  it("одинаковый текст → один платный вызов", async () => {
    const inner = new CountingEmbed();
    const c = new CachingEmbeddingProvider(inner);
    await c.embed("привет");
    await c.embed("привет");
    expect(inner.calls).toBe(1);
    expect(c.stats.hits).toBe(1);
    await c.embed("мир");
    expect(inner.calls).toBe(2);
  });

  it("null (сбой/стаб) не кешируется", async () => {
    const inner = new CountingEmbed(null);
    const c = new CachingEmbeddingProvider(inner);
    await c.embed("x");
    await c.embed("x");
    expect(inner.calls).toBe(2);
  });
});

// ── web ──────────────────────────────────────────────────────

class CountingWeb implements IWebProvider {
  readonly live = true;
  searchCalls = 0;
  fetchCalls = 0;
  async search(query: string): Promise<SearchHit[]> {
    this.searchCalls += 1;
    return query === "empty" ? [] : [{ title: "t", url: "u", snippet: "s" }];
  }
  async fetch(url: string): Promise<FetchedPage | null> {
    this.fetchCalls += 1;
    return url === "none" ? null : { url, title: "t", text: "body" };
  }
}

describe("CachingWebProvider (§12, §15)", () => {
  it("search кешируется; пустой результат — нет", async () => {
    const inner = new CountingWeb();
    const w = new CachingWebProvider(inner);
    await w.search("hi");
    await w.search("hi");
    expect(inner.searchCalls).toBe(1); // кеш-хит
    await w.search("empty");
    await w.search("empty");
    expect(inner.searchCalls).toBe(3); // пустой не кешируется → ещё 2 вызова
  });

  it("fetch кешируется; null — нет", async () => {
    const inner = new CountingWeb();
    const w = new CachingWebProvider(inner);
    await w.fetch("u1");
    await w.fetch("u1");
    expect(inner.fetchCalls).toBe(1);
    await w.fetch("none");
    await w.fetch("none");
    expect(inner.fetchCalls).toBe(3);
  });
});

// ── TTS ──────────────────────────────────────────────────────

class CountingTts implements ITtsProvider {
  readonly live = false;
  calls = 0;
  private readonly inner = new MockTtsProvider(2);
  synthesize(text: string, opts?: TtsOpts): TtsStream {
    this.calls += 1;
    return this.inner.synthesize(text, opts);
  }
}

/** Прогнать синтез до конца, собрав чанки. */
function drainTts(stream: TtsStream): Promise<TtsChunk[]> {
  return new Promise((resolve) => {
    const chunks: TtsChunk[] = [];
    stream.onChunk((c) => chunks.push(c));
    stream.onDone(() => resolve(chunks));
  });
}

describe("CachingTtsProvider (§15, §21)", () => {
  it("повторная фраза проигрывается из кеша, без вызова провайдера", async () => {
    const inner = new CountingTts();
    const tts = new CachingTtsProvider(inner);

    const first = await drainTts(tts.synthesize("секунду"));
    expect(inner.calls).toBe(1);
    expect(first.length).toBeGreaterThan(0);

    const second = await drainTts(tts.synthesize("секунду"));
    expect(inner.calls).toBe(1); // кеш-хит — провайдер не дёрнут
    expect(second.length).toBe(first.length);
    expect(tts.stats.hits).toBe(1);
  });
});

// ── agent-loop кеш-брейкпоинт ────────────────────────────────

/** cache_control первого блока сообщения (узкое приведение для теста). */
function ccOf(m: LlmMessage): unknown {
  if (typeof m.content === "string") return undefined;
  return (m.content[0] as { cache_control?: unknown }).cache_control;
}

describe("markCacheBreakpoint (§15)", () => {
  it("держит ровно одну метку — на последнем блоке последнего сообщения", () => {
    const convo: LlmMessage[] = [
      { role: "user", content: "привет" }, // строка — пропускается
      {
        role: "assistant",
        content: [
          { type: "text", text: "ок" },
          { type: "tool_use", id: "1", name: "x", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "r1" }] },
    ];

    markCacheBreakpoint(convo);
    expect(ccOf(convo[2]!)).toBeDefined();

    // следующий раунд — метка переезжает, прежняя снимается
    convo.push({ role: "assistant", content: [{ type: "tool_use", id: "2", name: "x", input: {} }] });
    convo.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "r2" }] });
    markCacheBreakpoint(convo);

    expect(ccOf(convo[2]!)).toBeUndefined();
    expect(ccOf(convo[4]!)).toBeDefined();

    const marks = convo
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .filter((b) => (b as { cache_control?: unknown }).cache_control).length;
    expect(marks).toBe(1); // не упираемся в лимит брейкпоинтов Anthropic (≤4)
  });
});

// ── Anthropic: съём cache-токенов ────────────────────────────

describe("SessionWarmth: тощий префикс вне сессии (§15)", () => {
  it("холодная → не кешируем; touch → тёплая; вне окна → снова холодная", () => {
    let t = 1000;
    const w = new SessionWarmth(5 * 60_000, () => t);
    expect(w.isWarm("s1")).toBe(false); // активности не было — кеш не греем
    w.touch("s1");
    expect(w.isWarm("s1")).toBe(true);
    t += 5 * 60_000 - 1;
    expect(w.isWarm("s1")).toBe(true); // ещё в окне
    t += 2;
    expect(w.isWarm("s1")).toBe(false); // окно истекло
  });

  it("forget забывает сессию", () => {
    const w = new SessionWarmth(1000, () => 0);
    w.touch("s");
    expect(w.isWarm("s")).toBe(true);
    w.forget("s");
    expect(w.isWarm("s")).toBe(false);
  });
});

describe("parseResponse: метрики prompt-кеша (§15)", () => {
  it("cache_read/creation_input_tokens → usage", () => {
    const r = parseResponse({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    });
    expect(r.usage.cacheReadTokens).toBe(100);
    expect(r.usage.cacheCreationTokens).toBe(20);
    expect(r.usage.inputTokens).toBe(10);
  });
});

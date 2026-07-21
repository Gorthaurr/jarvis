import { afterEach, describe, expect, it } from "vitest";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { InMemoryEpisodicMemory, cosine, memoryMinScore } from "./episodic.js";

// Аудит контекста 2026-07-20 + адверс-ревью F4: порог авто-ретривала embedder-aware.
describe("memoryMinScore (порог авто-ретривала)", () => {
  const saved = { min: process.env.JARVIS_MEMORY_MIN_SCORE, oa: process.env.OPENAI_API_KEY };
  afterEach(() => {
    if (saved.min == null) delete process.env.JARVIS_MEMORY_MIN_SCORE; else process.env.JARVIS_MEMORY_MIN_SCORE = saved.min;
    if (saved.oa == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.oa;
  });

  it("дефолт для e5-small = 0.82 (без OPENAI_API_KEY)", () => {
    delete process.env.JARVIS_MEMORY_MIN_SCORE;
    delete process.env.OPENAI_API_KEY;
    expect(memoryMinScore()).toBe(0.82);
  });

  it("OpenAI-путь (иная шкала косинусов) → дефолт 0, не убиваем ретривал молча", () => {
    delete process.env.JARVIS_MEMORY_MIN_SCORE;
    process.env.OPENAI_API_KEY = "sk-test";
    expect(memoryMinScore()).toBe(0);
  });

  it("явный env перекрывает оба пути и клампится [0,1]", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.JARVIS_MEMORY_MIN_SCORE = "0.9";
    expect(memoryMinScore()).toBe(0.9);
    process.env.JARVIS_MEMORY_MIN_SCORE = "5";
    expect(memoryMinScore()).toBe(1);
  });
});

describe("cosine", () => {
  it("идентичные векторы → 1, ортогональные → 0", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe("InMemoryEpisodicMemory (§8)", () => {
  it("семантический retrieval поднимает релевантный факт наверх", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await mem.write({ userId: "u", kind: "fact", text: "ходит в зал по понедельникам средам пятницам", ts: 1 });
    await mem.write({ userId: "u", kind: "preference", text: "любит пиццу пепперони из соседней пиццерии", ts: 2 });
    await mem.write({ userId: "u", kind: "event", text: "вчера купил новую клавиатуру", ts: 3 });

    const hits = await mem.search("u", "когда у меня тренировка в зале", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.episode.text).toContain("зал");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("изолирует по userId", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await mem.write({ userId: "a", kind: "fact", text: "секрет пользователя a", ts: 1 });
    const hits = await mem.search("b", "секрет", 5);
    expect(hits).toHaveLength(0);
  });

  // Аудит контекста 2026-07-20: честное забывание (раньше stale в рантайме никто не выставлял).
  it("markStale убирает близкие эпизоды из последующего поиска (порог 0 → берёт top-1)", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await mem.write({ userId: "u", kind: "fact", text: "работает в Сбербанке аналитиком", ts: 1 });
    await mem.write({ userId: "u", kind: "preference", text: "любит горький шоколад", ts: 2 });
    const before = mem.size;

    const r = await mem.markStale("u", "работает в Сбербанке аналитиком", 0, 1);
    expect(r.staled).toBe(1);
    expect(r.texts[0]).toContain("Сбербанк");
    expect(mem.size).toBe(before - 1); // забытый эпизод удалён из стора (эквивалент stale)
  });

  it("markStale НЕ трогает чужого пользователя и уважает порог (высокий → 0 совпадений)", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await mem.write({ userId: "a", kind: "fact", text: "живёт в Москве", ts: 1 });
    // Чужой userId — не должен ничего забыть у 'a'.
    const other = await mem.markStale("b", "живёт в Москве", 0, 5);
    expect(other.staled).toBe(0);
    // Заведомо недостижимый порог 1.01 → ничего не забыто (косинус ≤ 1).
    const tooHigh = await mem.markStale("a", "живёт в Москве", 1.01, 5);
    expect(tooHigh.staled).toBe(0);
    expect(mem.size).toBe(1); // факт 'a' цел
  });
});

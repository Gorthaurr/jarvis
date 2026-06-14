import { describe, expect, it } from "vitest";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { InMemoryEpisodicMemory, cosine } from "./episodic.js";

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
});

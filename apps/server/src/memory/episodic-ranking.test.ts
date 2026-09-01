/**
 * 🔴 РАНЖИРОВАНИЕ ПАМЯТИ — ПО СУЩЕСТВУ (аудит тестовой базы 2026-09-01).
 *
 * Прежний тест «семантический retrieval поднимает релевантный факт наверх» писал релевантную запись
 * ПЕРВОЙ, поэтому `hits[0]` оказывался верным при ЛЮБОМ порядке: удаление сортировки по релевантности
 * прогон не замечал. То же с порогом: `filter(score >= minScore)` можно было снять целиком.
 *
 * Цена ошибки здесь не абстрактная: без сортировки в доверенный блок промпта поднимается случайная
 * запись, без порога — шум, который модель предъявит владельцу как факт о нём.
 *
 * Поэтому: релевантная запись пишется ПОСЛЕДНЕЙ (порядок вставки не помогает), а порог проверяется
 * наблюдаемым отсевом.
 */
import { describe, expect, it } from "vitest";
import { InMemoryEpisodicMemory } from "./episodic.js";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";

/** Эмбеддер, где близость задаётся явно: так тест не зависит от капризов настоящей модели. */
class ToyEmbedder {
  async embed(text: string): Promise<number[] | null> {
    const t = text.toLowerCase();
    // Три ортогональные «темы»; вес — доля темы в тексте.
    const dims = [/зал|трениров/g, /пицц|еда|ужин/g, /клавиатур|покупк/g].map((re) => (t.match(re) ?? []).length);
    const norm = Math.hypot(...dims) || 1;
    return dims.map((d) => d / norm);
  }
}

describe("порядок выдачи памяти определяется релевантностью, а не порядком записи", () => {
  it("релевантная запись, добавленная ПОСЛЕДНЕЙ, всё равно идёт первой", async () => {
    const mem = new InMemoryEpisodicMemory(new ToyEmbedder());
    await mem.write({ userId: "u", kind: "preference", text: "любит пиццу пепперони", ts: 1 });
    await mem.write({ userId: "u", kind: "event", text: "купил клавиатуру", ts: 2 });
    await mem.write({ userId: "u", kind: "fact", text: "тренировка в зале по средам", ts: 3 }); // ← последней

    const hits = await mem.search("u", "когда у меня тренировка в зале", 3);

    expect(hits[0]?.episode.text).toContain("зал"); // ← до фикса теста это было верно «само собой»
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0); // и порядок именно по релевантности
  });

  it("порог отсекает нерелевантное: в выдачу не попадает шум", async () => {
    const mem = new InMemoryEpisodicMemory(new ToyEmbedder());
    await mem.write({ userId: "u", kind: "preference", text: "любит пиццу пепперони", ts: 1 });
    await mem.write({ userId: "u", kind: "fact", text: "тренировка в зале по средам", ts: 2 });

    const strict = await mem.search("u", "тренировка в зале", 5, 0.5);

    expect(strict).toHaveLength(1); // пицца к вопросу о зале отношения не имеет
    expect(strict[0]?.episode.text).toContain("зал");
    expect(strict.every((h) => h.score >= 0.5)).toBe(true);
  });

  it("без порога (явный memory_search) выдаются и слабые совпадения — решает модель", async () => {
    const mem = new InMemoryEpisodicMemory(new ToyEmbedder());
    await mem.write({ userId: "u", kind: "preference", text: "любит пиццу пепперони", ts: 1 });
    await mem.write({ userId: "u", kind: "fact", text: "тренировка в зале по средам", ts: 2 });

    const all = await mem.search("u", "тренировка в зале", 5, 0);

    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all[0]?.episode.text).toContain("зал"); // но сильное всё равно первым
  });

  it("лимит k режет ХВОСТ выдачи, а не голову (лучшее не теряется)", async () => {
    const mem = new InMemoryEpisodicMemory(new ToyEmbedder());
    await mem.write({ userId: "u", kind: "preference", text: "любит пиццу", ts: 1 });
    await mem.write({ userId: "u", kind: "event", text: "купил клавиатуру", ts: 2 });
    await mem.write({ userId: "u", kind: "fact", text: "тренировка в зале", ts: 3 });

    const top1 = await mem.search("u", "тренировка в зале", 1);

    expect(top1).toHaveLength(1);
    expect(top1[0]?.episode.text).toContain("зал");
  });

  it("устаревшая (помеченная) запись в выдачу не возвращается", async () => {
    const mem = new InMemoryEpisodicMemory(new ToyEmbedder());
    await mem.write({ userId: "u", kind: "fact", text: "тренировка в зале по средам", ts: 1 });
    await mem.markStale("u", "тренировка в зале", 0.3, 5);

    const hits = await mem.search("u", "тренировка в зале", 5, 0);

    expect(hits.every((h) => !h.episode.text.includes("зале по средам"))).toBe(true);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { InMemoryEpisodicMemory, PgVectorEpisodicMemory, cosine, memoryMinScore } from "./episodic.js";

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

// Волна E (вкладка «Память»): владелец ВИДИТ накопленное и точечно забывает — листинг без семантики
// (search требует запроса и порога; владельцу нужно увидеть ВСЁ) + удаление по конкретному id.
describe("InMemoryEpisodicMemory — листинг и точечное забывание для UI (волна E)", () => {
  it("listRecent отдаёт живые записи новыми вперёд и уважает limit", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await mem.write({ userId: "u", kind: "fact", text: "старое", ts: 1000 });
    await mem.write({ userId: "u", kind: "fact", text: "среднее", ts: 2000 });
    await mem.write({ userId: "u", kind: "event", text: "свежее", ts: 3000 });

    const all = await mem.listRecent("u", 10);
    expect(all.map((e) => e.text)).toEqual(["свежее", "среднее", "старое"]);
    const capped = await mem.listRecent("u", 2);
    expect(capped).toHaveLength(2);
    expect(capped[0]?.text).toBe("свежее");
  });

  it("listRecent фильтрует подстрокой (регистронезависимо) и изолирует по userId", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await mem.write({ userId: "u", kind: "fact", text: "Работает в Сбербанке", ts: 1 });
    await mem.write({ userId: "u", kind: "fact", text: "любит кофе", ts: 2 });
    await mem.write({ userId: "other", kind: "fact", text: "чужой сбербанк", ts: 3 });

    const hits = await mem.listRecent("u", 10, "сбер");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe("Работает в Сбербанке");
    expect(await mem.listRecent("u", 10, "ничего-такого")).toHaveLength(0);
  });

  it("markStaleById убирает ИМЕННО выбранную запись; чужую и несуществующую не трогает", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await mem.write({ userId: "u", kind: "fact", text: "первый", ts: 1 });
    await mem.write({ userId: "u", kind: "fact", text: "второй", ts: 2 });
    await mem.write({ userId: "other", kind: "fact", text: "чужой", ts: 3 });
    const list = await mem.listRecent("u", 10);
    const target = list.find((e) => e.text === "первый");
    expect(target).toBeDefined();

    expect(await mem.markStaleById("u", target!.id)).toBe(true);
    const after = await mem.listRecent("u", 10);
    expect(after.map((e) => e.text)).toEqual(["второй"]); // забыт ровно один, соседний цел

    // Чужая запись по чужому userId — не наша (изоляция §6B/B3), и несуществующий id — честный false.
    const foreign = await mem.listRecent("other", 10);
    expect(await mem.markStaleById("u", foreign[0]!.id)).toBe(false);
    expect(await mem.markStaleById("u", "нет-такого-id")).toBe(false);
    expect(await mem.listRecent("other", 10)).toHaveLength(1); // чужое цело
  });

  it("забытая запись исчезает и из семантического поиска (мягкое удаление = вне промпта)", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await mem.write({ userId: "u", kind: "fact", text: "работает в Сбербанке аналитиком", ts: 1 });
    const [row] = await mem.listRecent("u", 10);
    await mem.markStaleById("u", row!.id);
    const hits = await mem.search("u", "где работает", 5);
    expect(hits.every((h) => !h.episode.text.includes("Сбербанке"))).toBe(true);
  });
});

// 🔴 ЧЕСТНОСТЬ «недоступно ≠ пусто» (найдено попыткой живого прогона без БД): PgVector.listRecent при
// неотвечающей БД ОБЯЗАН бросить, иначе вкладка «Память» покажет «Джарвис ничего не помнит» вместо
// «не смог прочитать» — ложный отчёт о состоянии памяти владельца.
describe("PgVectorEpisodicMemory.listRecent — БД недоступна ≠ память пуста", () => {
  it("без БД бросает (а НЕ возвращает пустой список)", async () => {
    const mem = new PgVectorEpisodicMemory(new HashEmbeddingProvider());
    // В тестовом окружении DATABASE_URL не задан → query() возвращает null (нет пула).
    await expect(mem.listRecent("u", 10)).rejects.toThrow(/недоступна|не отвечает/i);
  });
});

import { describe, expect, it } from "vitest";
import type { EmbeddingKind, IEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { SemanticResponseCache, isCacheableQuery } from "./response-cache.js";

/** Фейк-эмбеддер: текст→вектор из карты (контролируем косинус); неизвестный текст → null. */
class MapEmbedder implements IEmbeddingProvider {
  readonly dim = 3;
  readonly live = true;
  lastKind: EmbeddingKind | undefined;
  constructor(private readonly map: Record<string, number[] | null>) {}
  async embed(text: string, kind: EmbeddingKind = "query"): Promise<number[] | null> {
    this.lastKind = kind;
    return text in this.map ? this.map[text]! : null;
  }
}

describe("isCacheableQuery", () => {
  it("фактический вопрос — кэшируем", () => {
    expect(isCacheableQuery("что такое фотосинтез")).toBe(true);
    expect(isCacheableQuery("объясни почему небо голубое")).toBe(true);
  });
  it("контекст-зависимые/личные/временные/состояние — НЕ кэшируем", () => {
    expect(isCacheableQuery("что ты думаешь об этом")).toBe(false); // ты + это
    expect(isCacheableQuery("сколько я потратил сегодня")).toBe(false); // я + потрат + сегодня
    expect(isCacheableQuery("который сейчас час")).toBe(false); // сейчас
    expect(isCacheableQuery("какая погода")).toBe(false); // погод
    expect(isCacheableQuery("напомни мне позвонить")).toBe(false); // напомн + мне
  });
  it("слишком короткое/длинное — НЕ кэшируем", () => {
    expect(isCacheableQuery("ок")).toBe(false);
    expect(isCacheableQuery("а".repeat(301))).toBe(false);
  });
  it("КОМАНДЫ-императивы — НЕ кэшируем (корень «заевшей пластинки»)", () => {
    expect(isCacheableQuery("перемотай яндекс музыку на минуту")).toBe(false); // перемот
    expect(isCacheableQuery("открой ютуб с котиками")).toBe(false); // открой
    expect(isCacheableQuery("поставь следующий трек")).toBe(false); // постав
    expect(isCacheableQuery("переключи на следующую песню")).toBe(false); // переключ
    expect(isCacheableQuery("отправь сообщение герману")).toBe(false); // отправ
    expect(isCacheableQuery("сделай погромче немного")).toBe(false); // сдела
  });
});

describe("SemanticResponseCache", () => {
  it("store→lookup: близкий запрос (cos≥0.92) → попадание", async () => {
    const emb = new MapEmbedder({
      "что такое фотосинтез": [1, 0, 0],
      "объясни что такое фотосинтез": [0.96, 0.28, 0], // cos с [1,0,0] ≈ 0.96 ≥ 0.92
    });
    const cache = new SemanticResponseCache(emb);
    await cache.store("u1", "что такое фотосинтез", "Процесс превращения света в энергию.");
    const hit = await cache.lookup("u1", "объясни что такое фотосинтез");
    expect(hit).toBe("Процесс превращения света в энергию.");
  });

  it("далёкий запрос (cos<0.92) → промах", async () => {
    const emb = new MapEmbedder({
      "что такое фотосинтез": [1, 0, 0],
      "что такое гравитация": [0, 1, 0], // cos 0
    });
    const cache = new SemanticResponseCache(emb);
    await cache.store("u1", "что такое фотосинтез", "ответ");
    expect(await cache.lookup("u1", "что такое гравитация")).toBeNull();
  });

  it("непригодный запрос НЕ ищется в кэше (даже без эмбеддинга)", async () => {
    const emb = new MapEmbedder({});
    const cache = new SemanticResponseCache(emb);
    expect(await cache.lookup("u1", "что ты думаешь")).toBeNull(); // отсечён isCacheableQuery
  });

  it("скоуп по userId: ответ одного юзера не отдаётся другому", async () => {
    const emb = new MapEmbedder({ "что такое квант": [1, 0, 0] });
    const cache = new SemanticResponseCache(emb);
    await cache.store("u1", "что такое квант", "ответ u1");
    expect(await cache.lookup("u2", "что такое квант")).toBeNull();
    expect(await cache.lookup("u1", "что такое квант")).toBe("ответ u1");
  });

  it("TTL: протухшая запись → промах", async () => {
    const emb = new MapEmbedder({ "что такое атом": [1, 0, 0] });
    let t = 1_000;
    const cache = new SemanticResponseCache(emb, () => t);
    await cache.store("u1", "что такое атом", "ядро + электроны");
    t += 6 * 3_600_000 + 1; // за пределом TTL (6ч)
    expect(await cache.lookup("u1", "что такое атом")).toBeNull();
  });

  it("ОТКАЗ-капитуляция НЕ кэшируется (не крутим «не могу» по кругу)", async () => {
    // запрос формально кэшируемый (вопрос), но ответ — отказ → store обязан отклонить
    const emb = new MapEmbedder({ "как сменить язык раскладки в виндовс": [1, 0, 0] });
    const cache = new SemanticResponseCache(emb);
    await cache.store("u1", "как сменить язык раскладки в виндовс", "Это я сделать не могу — нет доступа.");
    expect(await cache.lookup("u1", "как сменить язык раскладки в виндовс")).toBeNull();
  });

  it("нет эмбеддинга (null-провайдер) → lookup/store безопасно no-op", async () => {
    const emb = new MapEmbedder({}); // всё → null
    const cache = new SemanticResponseCache(emb);
    await cache.store("u1", "что такое энтропия", "мера беспорядка");
    expect(await cache.lookup("u1", "что такое энтропия")).toBeNull();
  });

  it("использует e5-префикс query при эмбеддинге", async () => {
    const emb = new MapEmbedder({ "что такое вектор": [1, 0, 0] });
    const cache = new SemanticResponseCache(emb);
    await cache.lookup("u1", "что такое вектор");
    expect(emb.lastKind).toBe("query");
  });
});

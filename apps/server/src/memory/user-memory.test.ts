import { afterAll, describe, expect, it, vi } from "vitest";

// Изолируем data-dir ДО импорта profile.ts (мост writeUserMemory/forgetUserMemory пишет в профиль).
const TMP = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  const dir = `${base}/jarvis-usermem-test-${process.pid}-${Date.now()}`;
  process.env.JARVIS_DATA_DIR = dir;
  return dir;
});

import { rmSync } from "node:fs";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { InMemoryEpisodicMemory } from "./episodic.js";
import { getProfile, readFactMeta } from "../brain/profile.js";
import { forgetMinScore, forgetUserMemory, writeUserMemory } from "./user-memory.js";

const U = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

// Адверс-ревью 2-й раунд F6: порог забывания embedder-aware (зеркально memoryMinScore/F4).
describe("forgetMinScore (порог забывания)", () => {
  const saved = { min: process.env.JARVIS_MEMORY_FORGET_MIN, oa: process.env.OPENAI_API_KEY };
  afterAll(() => {
    if (saved.min == null) delete process.env.JARVIS_MEMORY_FORGET_MIN; else process.env.JARVIS_MEMORY_FORGET_MIN = saved.min;
    if (saved.oa == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.oa;
  });
  it("e5-small (без OPENAI_API_KEY) → 0.85, консервативнее retrieval (0.82)", () => {
    delete process.env.JARVIS_MEMORY_FORGET_MIN;
    delete process.env.OPENAI_API_KEY;
    expect(forgetMinScore()).toBe(0.85);
  });
  it("OpenAI-путь → 0.6 (иная шкала, не мёртво-высокий 0.85)", () => {
    delete process.env.JARVIS_MEMORY_FORGET_MIN;
    process.env.OPENAI_API_KEY = "sk-test";
    expect(forgetMinScore()).toBe(0.6);
  });
  it("явный env перекрывает и клампится", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.JARVIS_MEMORY_FORGET_MIN = "0.9";
    expect(forgetMinScore()).toBe(0.9);
    process.env.JARVIS_MEMORY_FORGET_MIN = "-1";
    expect(forgetMinScore()).toBe(0);
  });
});

describe("user-memory: write + forget (аудит контекста 2026-07-20)", () => {
  afterAll(() => {
    try {
      rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("forgetUserMemory: stale-ит эпизод И убирает мостовой факт профиля (без двойного счёта)", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await writeUserMemory(mem, U, "fact", "работает в Сбербанке");
    // Мост в профиль сработал.
    expect(getProfile(U).facts).toContain("работает в Сбербанке");
    expect(mem.size).toBe(1);

    const r = await forgetUserMemory(mem, U, "работает в Сбербанке");
    expect(r.forgotten).toBe(1); // один и тот же факт: эпизод+профиль считаем ОДИН раз
    expect(r.texts).toContain("работает в Сбербанке");
    // Эпизод забыт (ушёл из поиска) И факт вычищен из профиля.
    expect(mem.size).toBe(0);
    expect(getProfile(U).facts ?? []).not.toContain("работает в Сбербанке");
  });

  it("forgetUserMemory: нечего забывать → forgotten=0 (честный исход)", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    const r = await forgetUserMemory(mem, "ffffffff-ffff-ffff-ffff-ffffffffffff", "чего не было");
    expect(r.forgotten).toBe(0);
    expect(r.texts).toEqual([]);
  });

  it("forgetUserMemory: пустой query — no-op", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    const r = await forgetUserMemory(mem, U, "   ");
    expect(r.forgotten).toBe(0);
  });

  it("forgetUserMemory деградирует без markStale у провайдера (чистит только профиль)", async () => {
    // Старый мок без markStale: forget всё равно вычищает курируемый факт (мост живёт без pgvector).
    await writeUserMemory(new InMemoryEpisodicMemory(new HashEmbeddingProvider()), U, "fact", "живёт в Москве");
    const noStale = {
      search: async () => [],
      write: async () => {},
    } as unknown as InMemoryEpisodicMemory;
    const r = await forgetUserMemory(noStale, U, "живёт в Москве");
    expect(r.forgotten).toBe(1); // факт профиля удалён, эпизодов не тронуто (нет markStale)
    expect(getProfile(U).facts ?? []).not.toContain("живёт в Москве");
  });
});

describe("F3 (волна F, адаптация OpenClaw): провенанс памяти", () => {
  it("writeUserMemory прокидывает source в эпизод И в sidecar-мету профиля", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await writeUserMemory(mem, U, "fact", "любит зелёный чай без сахара", { source: "consolidation" });
    const [ep] = await mem.listRecent(U, 10, "зелёный чай");
    expect(ep?.source).toBe("consolidation"); // владелец увидит «сон-цикл» у эпизода
    // Мост в профиль — fire-and-forget (void addFact): мета дописывается чуть позже возврата.
    await vi.waitFor(async () => {
      const meta = await readFactMeta(U);
      expect(meta.get("любит зелёный чай без сахара")?.source).toBe("consolidation");
      expect(meta.get("любит зелёный чай без сахара")?.ts).toBeTypeOf("number");
    });
  });

  it("без source — запись как раньше (легаси-совместимость, провенанс не выдумывается)", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await writeUserMemory(mem, U, "fact", "ходит в зал по средам");
    const [ep] = await mem.listRecent(U, 10, "в зал");
    expect(ep?.source).toBeUndefined();
    expect((await readFactMeta(U)).get("ходит в зал по средам")).toBeUndefined();
  });
});

describe("F3/H: supersede — устаревший факт не всплывает, но и не пропадает молча", () => {
  it("помеченный заменённым исчезает из search/listRecent, но виден в listSuperseded", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    const U2 = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";
    await writeUserMemory(mem, U2, "fact", "работает в Сбере");
    const [old] = await mem.listRecent(U2, 10, "Сбере");
    expect(old).toBeDefined();

    expect(await mem.supersede(U2, old!.id)).toBe(true);
    // Живые пути чтения его больше не отдают — в промпт устаревшее не попадёт.
    expect((await mem.listRecent(U2, 10, "Сбере")).length).toBe(0);
    expect((await mem.search(U2, "работает в Сбере", 5, 0)).length).toBe(0);
    expect(await mem.hasEntries(U2)).toBe(false);
    // Но владелец может увидеть, ЧТО именно заменено (иначе — молчаливое исчезновение).
    const gone = await mem.listSuperseded(U2, 10);
    expect(gone.map((g) => g.text)).toContain("работает в Сбере");
    expect(gone[0]?.invalidAt).toBeTypeOf("number");
  });

  it("повторный supersede той же записи → false (идемпотентно, без двойного учёта)", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    const U3 = "bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb";
    await writeUserMemory(mem, U3, "fact", "живёт в Москве");
    const [rec] = await mem.listRecent(U3, 10, "Москве");
    expect(await mem.supersede(U3, rec!.id)).toBe(true);
    expect(await mem.supersede(U3, rec!.id)).toBe(false);
  });

  it("чужую запись не помечаем", async () => {
    const mem = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    await writeUserMemory(mem, "cccccccc-0000-0000-0000-cccccccccccc", "fact", "мой факт");
    const [rec] = await mem.listRecent("cccccccc-0000-0000-0000-cccccccccccc", 10);
    expect(await mem.supersede("dddddddd-0000-0000-0000-dddddddddddd", rec!.id)).toBe(false);
  });
});

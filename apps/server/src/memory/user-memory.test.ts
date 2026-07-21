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
import { getProfile } from "../brain/profile.js";
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

// Волна H (шаг 3): хук противоречий на записи памяти — главный рычаг честности.
import { afterEach, describe, expect, it, vi } from "vitest";
import { contradictionHookEnabled, findContradictions, nearbyCandidates } from "./contradiction-hook.js";
import type { EpisodeHit } from "./episodic.js";
import type { ILlmProvider, LlmResponse } from "../integrations/llm.js";

function hit(text: string, score: number, id = text): EpisodeHit {
  return { episode: { id, userId: "u1", kind: "fact", text, ts: 1 }, score };
}

function llmWith(text: string, over: Partial<LlmResponse> = {}): ILlmProvider {
  return {
    live: true,
    async complete(): Promise<LlmResponse> {
      return {
        text,
        toolUses: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stubbed: false,
        ...over,
      };
    },
    completeStream: async () => {
      throw new Error("не используется");
    },
  };
}

afterEach(() => {
  delete process.env.JARVIS_CONTRADICTION_HOOK;
});

describe("nearbyCandidates (кого вообще проверять)", () => {
  it("берёт только зону «не дубль, но и не мимо» (0.7 ≤ score < 0.93)", () => {
    const got = nearbyCandidates([hit("дубль", 0.95), hit("сосед", 0.86), hit("мимо", 0.5)]);
    expect(got.map((h) => h.episode.text)).toEqual(["сосед"]);
  });

  it("капается пятью — узкий вопрос модели, а не простыня", () => {
    const many = Array.from({ length: 9 }, (_, i) => hit(`факт ${i}`, 0.8));
    expect(nearbyCandidates(many)).toHaveLength(5);
  });
});

describe("findContradictions", () => {
  const cands = [hit("работает в Сбере", 0.86), hit("любит джаз", 0.75)];

  it("модель назвала номер → возвращаем индекс противоречащего", async () => {
    const idx = await findContradictions({ llm: llmWith("[1]"), model: "m" }, "работает в Яндексе", cands);
    expect(idx).toEqual([0]);
  });

  it("пустой ответ модели — нормальный исход (ничего не помечаем)", async () => {
    expect(await findContradictions({ llm: llmWith("[]"), model: "m" }, "любит рок", cands)).toEqual([]);
  });

  // 🔴 ЧЕСТНОСТЬ: «не проверено» ≠ «противоречит». Стаб/мусор/выключен → НЕ трогаем память.
  it("стаб LLM (сеть/лимит) → пусто, а не догадка", async () => {
    const stub = llmWith("[1]", { stubbed: true, stopReason: "stub" });
    expect(await findContradictions({ llm: stub, model: "m" }, "работает в Яндексе", cands)).toEqual([]);
  });

  it("мусор вместо JSON → пусто", async () => {
    expect(await findContradictions({ llm: llmWith("не знаю"), model: "m" }, "x", cands)).toEqual([]);
  });

  it("номера вне диапазона отбрасываются (модель может выдумать)", async () => {
    expect(await findContradictions({ llm: llmWith("[1, 7, 0, -2]"), model: "m" }, "x", cands)).toEqual([0]);
  });

  it("падение провайдера не роняет запись памяти", async () => {
    const broken: ILlmProvider = {
      live: true,
      complete: async () => {
        throw new Error("сеть");
      },
      completeStream: async () => {
        throw new Error("сеть");
      },
    };
    expect(await findContradictions({ llm: broken, model: "m" }, "x", cands)).toEqual([]);
  });

  it("исчерпан лимит трат → хук молчит (фон не обходит потолок)", async () => {
    const llm = llmWith("[1]");
    const spy = vi.fn(async () => llm.complete({} as never));
    const spend = { check: () => ({ allowed: false }), recordStep: vi.fn(), finishTask: vi.fn() };
    expect(await findContradictions({ llm: { ...llm, complete: spy }, model: "m", spend }, "x", cands)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("выключатель JARVIS_CONTRADICTION_HOOK=0 гасит хук", async () => {
    process.env.JARVIS_CONTRADICTION_HOOK = "0";
    expect(contradictionHookEnabled()).toBe(false);
    expect(await findContradictions({ llm: llmWith("[1]"), model: "m" }, "x", cands)).toEqual([]);
  });

  it("нет кандидатов → LLM не зовём вовсе", async () => {
    const spy = vi.fn();
    const llm = { ...llmWith("[1]"), complete: spy } as unknown as ILlmProvider;
    expect(await findContradictions({ llm, model: "m" }, "x", [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

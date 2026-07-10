import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmRequest, LlmResponse } from "../../integrations/llm.js";
import type { EpisodeHit, EpisodicMemory } from "../../memory/episodic.js";
import { hasStableFactMarker, reflectFactFromUtterance } from "./memory-reflect.js";
import { writeUserMemory } from "../../memory/user-memory.js";

/** Мини-эпизодка: search по скрипту, write копит. */
function fakeEpisodic(hits: EpisodeHit[] = []): EpisodicMemory & { written: Array<{ kind: string; text: string }> } {
  const written: Array<{ kind: string; text: string }> = [];
  return {
    written,
    async search() {
      return hits;
    },
    async write(e) {
      written.push({ kind: e.kind, text: e.text });
    },
  };
}

function fakeLlm(resp: Partial<LlmResponse>): { requests: LlmRequest[]; complete(req: LlmRequest): Promise<LlmResponse> } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async complete(req: LlmRequest) {
      requests.push(req);
      return {
        text: "",
        toolUses: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ...resp,
      } as LlmResponse;
    },
  };
}

describe("hasStableFactMarker — префильтр устойчивого факта (А3)", () => {
  it("заявления о себе/родне/аллергии → true", () => {
    expect(hasStableFactMarker("я всегда встаю в шесть утра")).toBe(true);
    expect(hasStableFactMarker("я не люблю кинзу")).toBe(true);
    expect(hasStableFactMarker("мой брат Женя приедет завтра")).toBe(true);
    expect(hasStableFactMarker("у меня аллергия на пыльцу")).toBe(true);
    expect(hasStableFactMarker("кстати, я работаю по ночам")).toBe(true);
  });

  it("команды/вопросы/игровой трёп → false (LLM не дёргаем)", () => {
    expect(hasStableFactMarker("запусти поиск в доте")).toBe(false);
    expect(hasStableFactMarker("сделай сводку новостей")).toBe(false);
    expect(hasStableFactMarker("да, хороший хилыч")).toBe(false);
    expect(hasStableFactMarker("сколько будет два плюс два")).toBe(false);
  });
});

describe("reflectFactFromUtterance — рефлекс-бэкстоп (fire-and-forget)", () => {
  beforeEach(() => {
    // stubEnv + unstub (ревью: голое присваивание утекало «1» в следующие файлы того же воркера).
    vi.stubEnv("JARVIS_MEMORY_REFLECT", "1"); // сетап глушит глобально — тест включает локально
    vi.stubEnv("JARVIS_MEMORY_REFLECT_CAP", "100");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("LLM вернул memory_write → факт записан в эпизодку", async () => {
    const episodic = fakeEpisodic();
    const llm = fakeLlm({
      toolUses: [{ id: "t1", name: "memory_write", input: { kind: "fact", content: "Работает по ночам" } }],
    });
    await reflectFactFromUtterance({ llm: llm as never, model: "sonnet-x", episodic, userId: "u1", utterance: "я работаю по ночам" });
    expect(episodic.written).toEqual([{ kind: "fact", text: "Работает по ночам" }]);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.tools?.map((t) => t.name)).toEqual(["memory_write"]); // узкий набор
  });

  it("LLM промолчал (фактов нет — частый исход) → ничего не пишем", async () => {
    const episodic = fakeEpisodic();
    const llm = fakeLlm({ text: "" });
    await reflectFactFromUtterance({ llm: llm as never, model: "m", episodic, userId: "u1", utterance: "я люблю когда тихо" });
    expect(episodic.written).toEqual([]);
  });

  it("выключатель JARVIS_MEMORY_REFLECT=0 → LLM не вызывается", async () => {
    vi.stubEnv("JARVIS_MEMORY_REFLECT", "0");
    const episodic = fakeEpisodic();
    const llm = fakeLlm({});
    await reflectFactFromUtterance({ llm: llm as never, model: "m", episodic, userId: "u1", utterance: "я всегда так делаю" });
    expect(llm.requests).toHaveLength(0);
  });

  it("суточный кап ограничивает ВЫЗОВЫ", async () => {
    vi.stubEnv("JARVIS_MEMORY_REFLECT_CAP", "1");
    const episodic = fakeEpisodic();
    const llm = fakeLlm({});
    await reflectFactFromUtterance({ llm: llm as never, model: "m", episodic, userId: "cap-user", utterance: "я люблю чай" });
    await reflectFactFromUtterance({ llm: llm as never, model: "m", episodic, userId: "cap-user", utterance: "я люблю кофе" });
    expect(llm.requests).toHaveLength(1);
  });
});

describe("writeUserMemory — единый писатель (А2/А9)", () => {
  it("новый факт → written; почти тот же (≥0.93) → duplicate, не пишем", async () => {
    const fresh = fakeEpisodic();
    expect(await writeUserMemory(fresh, "u1", "fact", "Работает по ночам")).toBe("written");
    expect(fresh.written).toHaveLength(1);
    const dup = fakeEpisodic([
      { episode: { id: "1", userId: "u1", kind: "fact", text: "Работает ночами", ts: 1 }, score: 0.95 },
    ]);
    expect(await writeUserMemory(dup, "u1", "fact", "Работает по ночам")).toBe("duplicate");
    expect(dup.written).toHaveLength(0);
  });

  it("пустой текст → empty; сбой дедуп-поиска НЕ блокирует запись", async () => {
    const episodic = fakeEpisodic();
    expect(await writeUserMemory(episodic, "u1", "fact", "   ")).toBe("empty");
    const broken = fakeEpisodic();
    broken.search = async () => {
      throw new Error("db down");
    };
    expect(await writeUserMemory(broken, "u1", "fact", "Кофе без сахара")).toBe("written");
  });
});

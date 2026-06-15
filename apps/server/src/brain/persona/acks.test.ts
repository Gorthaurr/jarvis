import { describe, expect, it } from "vitest";
import { MockLlmProvider } from "../../integrations/llm.js";
import { ButlerAcks, DEFAULT_BUTLER_ACKS, parseAckLines } from "./acks.js";

describe("ButlerAcks (§11 дворецкие подтверждения голосом персоны)", () => {
  it("без LLM отдаёт seed-фразы по ротации (детерминированно, обёртка по модулю)", () => {
    const a = new ButlerAcks();
    expect(a.isWarm).toBe(false);
    expect(a.pick(0)).toBe(DEFAULT_BUTLER_ACKS[0]);
    expect(a.pick(1)).toBe(DEFAULT_BUTLER_ACKS[1]);
    expect(a.pick(DEFAULT_BUTLER_ACKS.length)).toBe(DEFAULT_BUTLER_ACKS[0]); // циклично
    // Отрицательный счётчик не должен ломать индексацию.
    expect(a.pick(-1)).toBe(DEFAULT_BUTLER_ACKS[DEFAULT_BUTLER_ACKS.length - 1]);
  });

  it("warm() заменяет пул фразами от LLM (голос персоны)", async () => {
    const llm = new MockLlmProvider([{ text: "Извольте, сэр.\nК вашим услугам, сэр.\nСей момент, сэр." }]);
    const a = new ButlerAcks({ llm, model: "h", persona: "ты дворецкий" });
    await a.warm(3);
    expect(a.isWarm).toBe(true);
    expect(a.phrases()).toEqual(["Извольте, сэр.", "К вашим услугам, сэр.", "Сей момент, сэр."]);
    expect(a.pick(0)).toBe("Извольте, сэр.");
  });

  it("warm() при пустом/мусорном ответе остаётся на seed (не падает)", async () => {
    const a = new ButlerAcks({ llm: new MockLlmProvider([{ text: "" }]), model: "h", persona: "p" });
    await a.warm();
    expect(a.isWarm).toBe(false);
    expect(a.phrases()).toEqual([...DEFAULT_BUTLER_ACKS]);
  });

  it("warm() идемпотентна — повторный вызов не зовёт LLM снова", async () => {
    const llm = new MockLlmProvider([{ text: "Раз, сэр.\nДва, сэр.\nТри, сэр." }]);
    const a = new ButlerAcks({ llm, model: "h", persona: "p" });
    await a.warm();
    await a.warm();
    expect(llm.requests).toHaveLength(1);
  });

  it("parseAckLines чистит нумерацию/маркеры/кавычки, отсевает длинное и дубли", () => {
    const out = parseAckLines(
      "1. Слушаюсь, сэр.\n- «Сей момент, сэр.»\n* Слушаюсь, сэр.\n\n" +
        "это слишком длинная фраза которая совсем не похожа на короткое дворецкое подтверждение",
    );
    expect(out).toEqual(["Слушаюсь, сэр.", "Сей момент, сэр."]);
  });
});

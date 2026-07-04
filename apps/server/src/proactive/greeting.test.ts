import { describe, expect, it } from "vitest";
import { MockLlmProvider } from "../integrations/llm.js";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { InMemoryEpisodicMemory } from "../memory/episodic.js";
import { buildGreeting, timeOfDay } from "./greeting.js";

const models = { haiku: "h", sonnet: "s", fable: "f" };
const epis = (): InMemoryEpisodicMemory => new InMemoryEpisodicMemory(new HashEmbeddingProvider());

describe("timeOfDay (§9)", () => {
  it("разбивает сутки на части", () => {
    expect(timeOfDay(new Date(2026, 0, 1, 3))).toBe("Доброй ночи");
    expect(timeOfDay(new Date(2026, 0, 1, 9))).toBe("Доброе утро");
    expect(timeOfDay(new Date(2026, 0, 1, 14))).toBe("Добрый день");
    expect(timeOfDay(new Date(2026, 0, 1, 21))).toBe("Добрый вечер");
  });
});

describe("buildGreeting (§11 контекстное приветствие)", () => {
  it("нет имени → онбординг-фолбэк (спрашивает обращение), LLM не зовётся", async () => {
    const llm = new MockLlmProvider([{ text: "НЕ ДОЛЖНО ПРОЗВУЧАТЬ" }]);
    const g = await buildGreeting({ llm, episodic: epis(), models }, "u1", {});
    expect(g).toContain("Как мне к вам обращаться");
    expect(llm.requests).toHaveLength(0); // без имени модель не трогаем
  });

  it("mock-LLM не live → детерминированный фолбэк по времени, обращение «сэр» (НЕ по имени)", async () => {
    const llm = new MockLlmProvider(); // live=false
    const g = await buildGreeting({ llm, episodic: epis(), models }, "u1", { name: "Антон" });
    expect(g).toContain("сэр"); // дворецкий: «сэр», а не имя
    expect(g).not.toContain("Антон"); // по имени НЕ окликает
    expect(g).toMatch(/Доброе утро|Добрый день|Добрый вечер|Доброй ночи/);
    expect(llm.requests).toHaveLength(0);
  });

  it("живой мозг + имя → опенер из КУРИРУЕМЫХ фактов; сырые эпизоды НЕ тянутся (чистый старт)", async () => {
    // live-провайдер, отдающий заранее заданную фразу.
    const llm = new MockLlmProvider([{ text: "Доброе утро, Антон. Вернёмся к дизайну?" }]);
    (llm as { live: boolean }).live = true; // имитируем живой мозг (по умолчанию mock — false)
    const memory = epis();
    // Авто-залогированный сырой эпизод НЕ должен всплывать в приветствии (источник «странных» воспоминаний).
    await memory.write({ userId: "u1", kind: "event", text: "настраивали дизайн интерфейса", ts: 1 });
    const g = await buildGreeting({ llm, episodic: memory, models }, "u1", { name: "Антон", facts: ["зал пн/ср/пт"] });
    expect(g).toBe("Доброе утро, Антон. Вернёмся к дизайну?");
    expect(llm.requests).toHaveLength(1);
    const userMsg = String(llm.requests[0]?.messages[0]?.content ?? "");
    expect(userMsg).toContain("зал пн/ср/пт"); // курируемые факты профиля — да
    expect(userMsg).not.toContain("настраивали дизайн"); // сырые эпизоды памяти — НЕТ
  });
});

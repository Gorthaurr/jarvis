/**
 * W3 (L-6) ПЕТЛЁЙ: handleUserText + НАСТОЯЩИЙ SubscriptionLlmProvider + настоящий dispatchTool (web_fetch) поверх
 * поддельного SDK, чей usage растёт с историей СЕССИИ (живая сессия CLI помнит всё, что в неё ушло).
 * Потолки контекста занижены (soft 20K / hard 30K токенов), страницы по ~25K символов: на третьей петля
 * сворачивает старую страницу. До W3 свёртка меняла только наш convo — следующий usage снова приходил у потолка,
 * и задача умирала `contextWrap` («задача разрослась…»). Теперь запрос несёт historyRewritten:"masked", провайдер
 * начинает сессию со свёрнутым транскриптом, и задача доходит до сводки.
 * Реверт-проверка (из копии): не ставить historyRewritten в model-call.ts ИЛИ игнорировать его в провайдере —
 * тест падает (реплика — про переполненную память, вторая сессия не начинается).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { SubscriptionLlmProvider } from "../../integrations/subscription-llm.js";
import { scriptedSdk } from "../../integrations/test-support/scripted-sdk.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

beforeEach(() => {
  vi.stubEnv("JARVIS_CONTEXT_SOFT_TOKENS", "20000");
  vi.stubEnv("JARVIS_CONTEXT_HARD_TOKENS", "30000");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const fetch = (url: string) => ({ tool: { name: "web_fetch", args: { url } } });
const PAGE = { url: "https://example.org/doc", title: "Отчёт", text: "Абзац отчёта о продажах за квартал. ".repeat(700) };

describe("W3 L-6: свёртка наблюдений доходит до живой сессии подписки", () => {
  it("четыре длинные страницы: петля сворачивает старые — задача завершается сводкой, а не «разрослась»", async () => {
    const sdk = scriptedSdk([
      fetch("https://example.org/a"),
      fetch("https://example.org/b"),
      fetch("https://example.org/c"),
      fetch("https://example.org/d"),
      { text: "Сводка готова, сэр: продажи росли все четыре квартала." },
    ]);
    const llm = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    const tasks = new TaskManager();
    const deps: AgentDeps = {
      memory: new WorkingMemory(),
      llm,
      episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
      web: new MockWebProvider([], PAGE),
      models: { haiku: "h", sonnet: "s", fable: "f" },
      spend: new SpendGuard(),
      userId: "u1",
      tasks,
    };
    const session = { sessionId: "s1", userId: "u1", sendAction: vi.fn(), send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
    const reply = await handleUserText(session, "прочитай четыре отчёта по ссылкам и сведи итог продаж", deps);
    expect(reply.voice).toMatch(/Сводка готова/u);
    expect(reply.voice).not.toMatch(/разрослась|не помещ/u);
    expect(sdk.cursor()).toBe(5); // модель прошла весь сценарий
    expect(sdk.queries.length).toBeGreaterThanOrEqual(2); // свёртка → новая сессия
    const fresh = sdk.queries[1]!;
    expect(fresh.promptText).toContain("наблюдение свёрнуто"); // новая сессия несёт СВЁРНУТУЮ историю
    expect(fresh.inputTokens[0]).toBeLessThan(sdk.queries[0]!.inputTokens.at(-1)!); // реальный промпт стал меньше
    expect(llm.liveSessions).toBe(0); // сессия освобождена в finally
  });
});

/**
 * КВОТА ТАРИФА ПРОВЕРЯЕТСЯ ПЕТЛЁЙ (правило аудита тестовой базы: проводку между механизмами — через
 * реальный `handleUserText`, не чистой функцией).
 *
 * Что закрываем:
 *  1) лимит из плана (SpendGuard.setLimits) реально останавливает второй платный раунд, и терминал —
 *     ЧЕСТНЫЙ продуктовый текст «кредиты тарифа исчерпаны», а не «связь прервалась» и не «Готово»;
 *  2) без продуктового текста (мастер-флаг 0) звучит прежний терминал «достигнут лимит» — регресс-канарейка;
 *  3) пороги soft/hard срабатывают из recordUsage ВНУТРИ петли (не только в юните SpendGuard).
 * Реверт-проверка: убери `setLimits` — тест 1 упадёт (петля прогонит оба раунда); сломай передачу
 * `quotaExhaustedText` в терминал — упадёт ассерт на текст.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../billing/index.js";
import type { Session } from "../gateway/session.js";
import { MockLlmProvider } from "../integrations/llm.js";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { MockWebProvider } from "../integrations/web.js";
import { InMemoryEpisodicMemory } from "../memory/episodic.js";
import { WorkingMemory } from "../memory/working.js";
import { TaskManager } from "../brain/tasks/manager.js";
import { type AgentDeps, handleUserText } from "../brain/agent/index.js";

function session(): Session {
  const sendAction = vi.fn((_cmd: ActionCommand, _t?: number) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }));
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}

function deps(llm: MockLlmProvider, spend: SpendGuard, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend,
    userId: "u1",
    tasks: new TaskManager(),
    ...over,
  };
}

/** Два платных раунда: поиск, затем ответ. Проверка check() оценивает раунд в $0.01 (agent/index.ts). */
const twoRounds = (usage?: Partial<{ inputTokens: number; outputTokens: number }>) =>
  new MockLlmProvider([
    { toolUses: [{ id: "w1", name: "web_search", input: { query: "погода" } }], ...(usage ? { usage } : {}) },
    { text: "Сегодня солнечно, сэр." },
  ]);

describe("квота тарифа — через петлю", () => {
  it("лимит плана останавливает второй раунд и терминал честный: «кредиты тарифа исчерпаны»", async () => {
    const guard = new SpendGuard();
    // 1-й раунд: 0 + оценка $0.01 ≤ $0.0102 → пройдёт; после него spent≈$0.00026; 2-й: 0.01026 > 0.0102 → стоп.
    guard.setLimits({ spendCap: 0.0102 });
    const llm = twoRounds();
    const tasks = new TaskManager();
    const reply = await handleUserText(session(), "какая погода", deps(llm, guard, { tasks, quotaExhaustedText: "Кредиты тарифа исчерпаны, сэр — продлите план или добавьте свой ключ." }));
    expect(llm.requests.length).toBe(1); // второй раунд не ушёл в модель
    expect(JSON.stringify(reply)).toContain("Кредиты тарифа исчерпаны");
    expect(JSON.stringify(reply)).not.toContain("Готово");
    const failed = tasks.list("u1").find((t) => t.state === "failed");
    expect(failed).toBeDefined();
  });

  it("без продуктового текста (флаг 0) — прежний терминал «достигнут лимит»", async () => {
    const guard = new SpendGuard();
    guard.setLimits({ spendCap: 0.0102 });
    const llm = twoRounds();
    const reply = await handleUserText(session(), "какая погода", deps(llm, guard));
    expect(llm.requests.length).toBe(1);
    expect(JSON.stringify(reply)).toContain("достигнут лимит");
  });

  it("пороги soft/hard срабатывают из recordUsage внутри петли", async () => {
    const guard = new SpendGuard();
    guard.setLimits({ spendCap: 0.0102, softPct: 80 });
    const fired: string[] = [];
    guard.onThreshold((kind) => fired.push(kind));
    // Неизвестная модель "s" тарифицируется как Opus: 12·5 + 1000·25 = 25 060 µ$ = $0.025 > cap → оба порога.
    const llm = twoRounds({ outputTokens: 1000 });
    await handleUserText(session(), "какая погода", deps(llm, guard));
    expect(fired).toEqual(["soft", "hard"]);
  });

  it("без лимита плана оба раунда проходят (контроль, что тест 1 не самообман)", async () => {
    const guard = new SpendGuard();
    const llm = twoRounds();
    const reply = await handleUserText(session(), "какая погода", deps(llm, guard));
    expect(llm.requests.length).toBe(2);
    expect(JSON.stringify(reply)).toContain("солнечно");
  });
});

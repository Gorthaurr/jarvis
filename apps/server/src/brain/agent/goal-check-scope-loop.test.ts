/**
 * Живой прогон 2026-09-24: «какая погода завтра в Москве?» → web_search → web_fetch → прогноз → goal-check «цель
 * достигнута?» → новый раунд подписки с нуля (16,8 с) → «Задача выполнена, сэр — прогноз получен и озвучен» ВМЕСТО
 * прогноза. goal-check ловит деградацию ДЕЙСТВИЯ до подцели; на вопросе и на ходе из одних чтений сверять нечего.
 * Реверт: убери ранний выход в loop/nudge-policy.ts goalCheck — первый тест упадёт (лишний раунд, ответ потерян).
 */
import { describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { type AgentDeps, handleUserText } from "./index.js";

function deps(llm: MockLlmProvider): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
  } as AgentDeps;
}
const session = () =>
  ({
    sessionId: "s1",
    userId: "u1",
    sendAction: vi.fn(async () => ({ commandId: "c", ok: true, durationMs: 1 })),
    send: vi.fn(),
    requestConfirm: vi.fn(),
  }) as unknown as Session;

describe("goal-check — только для действий", () => {
  it("вопрос с поиском: ответ модели доходит до владельца, лишнего раунда «цель достигнута?» нет", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "s1", name: "web_search", input: { query: "погода Москва завтра" } }] },
      { toolUses: [{ id: "f1", name: "web_fetch", input: { url: "https://example.com/weather" } }] },
      { text: "Завтра в Москве днём около тринадцати, пасмурно, без осадков." },
      { text: "Задача выполнена, сэр — прогноз получен и озвучен." }, // так отвечала модель на goal-check
    ]);
    const reply = await handleUserText(session(), "какая погода завтра в Москве?", deps(llm));
    expect(reply.voice).toMatch(/тринадцати/u);
    expect(llm.requests).toHaveLength(3);
  });

  // Контроль-1 №10 (ревью 2026-09-24): действие, где модель только ЧИТАЛА экран, а в финале заявила «Открыл…» —
  // сверять есть что. Реверт: верни условие `|| !st.honesty.anyMutateAttempted` без claimsOwnAction — раундов будет 3.
  it("действие без единой мутации, но финал заявляет сделанное («Открыл…») → goal-check сверяет с целью", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "l1", name: "look", input: { what: "elements" } }] },
      { toolUses: [{ id: "l2", name: "look", input: { what: "windows" } }] },
      { text: "Переключил вывод звука на наушники, сэр." },
      { text: "Вывод не переключён — я только посмотрел список устройств." },
    ]);
    await handleUserText(session(), "переключи вывод звука на наушники", deps(llm));
    expect(llm.requests.length).toBeGreaterThanOrEqual(4); // был goal-check-раунд
  });

  // Контроль-2 №1: ответ из прочитанного с причастием («открыт до 20:00») или цитатой («Я отправила…») — не заявка
  // о сделанном. Реверт: верни регэксп с `открыт|запущен|готово` и `\p{L}*` — лишний раунд, ответ потерян.
  it("чтение с причастием/цитатой в ответе («открыт до 20:00») → ответ доходит, goal-check не вмешивается", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "s1", name: "web_search", input: { query: "МФЦ часы работы" } }] },
      { toolUses: [{ id: "f1", name: "web_fetch", input: { url: "https://example.com/mfc" } }] },
      { text: "МФЦ на Тверской открыт до 20:00, сэр, без перерыва." },
      { text: "Задача выполнена, сэр." },
    ]);
    const reply = await handleUserText(session(), "найди, до скольки работает МФЦ на Тверской", deps(llm));
    expect(reply.voice).toMatch(/МФЦ на Тверской открыт/u);
    expect(llm.requests).toHaveLength(3);
  });

  it("claimsOwnAction: своё действие первым словом — да; причастие, чужое лицо, цитата — нет", async () => {
    const { claimsOwnAction } = await import("./loop/nudge-policy.js");
    for (const t of ["Открыл настройки звука, сэр.", "Готово, переключил вывод на наушники.", "Я запустил Доту."]) expect(claimsOwnAction(t), t).toBe(true);
    for (const t of ["МФЦ открыт до 20:00.", "Режиссёр сделал ставку на звук.", "Катя пишет: «Я открыла и отправила».", "Сервер запущен."]) expect(claimsOwnAction(t), t).toBe(false);
  });

  it("действие (мутация): goal-check по-прежнему сверяет с исходной целью", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "a1", name: "app_launch", input: { app: "dota2" } }] },
      { toolUses: [{ id: "a2", name: "system_volume", input: { op: "up" } }] },
      { text: "Запустил Доту, сэр." },
      { text: "Дота запущена, поиск матча ещё не начат." },
    ]);
    await handleUserText(session(), "запусти поиск матча в доте", deps(llm));
    expect(llm.requests.length).toBeGreaterThanOrEqual(4); // был goal-check-раунд
  });
});

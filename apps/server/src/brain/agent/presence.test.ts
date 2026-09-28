/**
 * Проверка связи и время — мгновенно, без модели (28.09). Часть 1 — allowlist форм; часть 2 — ПЕТЛЁЙ (handleUserText):
 * реплика из живого лога «Джарвис, ты слышишь?» не доходит до LLM и не заводит фоновую задачу; фраза с настоящей
 * командой — по-прежнему в модель.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";
import { matchPresence, presenceVoice } from "./presence.js";

describe("matchPresence: точные формы", () => {
  it.each([
    ["Джарвис, ты меня слышишь?", "hear"], // живой лог 28.09
    ["Джарвис, ты слышишь?", "hear"],
    ["Джарвис, слышишь?", "hear"],
    ["Джарвис, как слышно?", "hear"],
    ["ты меня слышишь", "hear"],
    ["Джарвис.", "listening"], // 28.09 22:35 — завело фоновую sonnet-задачу
    ["Джарвис!", "listening"],
    ["Прием.", "radio"], // 28.09 22:39 — то же
    ["Джарвис, прием.", "radio"],
    ["Джарвис, приём", "radio"],
    ["С приемом", "radio"], // STT-ослышка «приём» (27.09 17:35)
    ["Джарвис, ты тут?", "here"],
    ["ты здесь", "here"],
    ["Джарвис, ты на связи?", "here"],
    ["Джарвис, сколько времени?", "time"], // 27.09 11:38 — 4 с через Opus
    ["который час", "time"],
  ])("«%s» → %s", (text, kind) => {
    expect(matchPresence(text)).toBe(kind);
  });

  it.each([
    "Джарвис, ты меня слышишь и открой ютуб", // есть команда — в модель
    "слышишь, включи музыку",
    "Джарвис, включи музыку",
    "привет",
    "пожалуйста",
    "давай",
    "Джарвис, ты тут закрыл мою вкладку?",
    "сколько времени осталось до конца теста",
    "приём таблеток по расписанию",
    "тут кнопка не работает",
    // L1 (ревью 28.09): голые «тут/здесь/там» — ответ на вопрос модели, не проверка связи
    "тут",
    "давай здесь",
    "ну там",
    "слушай, тут",
    "Джарвис, на втором мониторе",
    // L2: приветствие — не «Слушаю, сэр»
    "Джарвис, привет",
    "Джарвис, здравствуй",
    "",
  ])("«%s» → не проверка связи", (text) => {
    expect(matchPresence(text)).toBeNull();
  });

  it("время: часы, а не выдумка; прозой для голоса", () => {
    const v = presenceVoice("time", new Date(2026, 8, 28, 14, 40));
    expect(v).toMatch(/^Сейчас .*сэр\.$/u);
    expect(v).not.toMatch(/\d/u); // цифры проговорены словами
    expect(v.toLowerCase()).toContain("четырнадцать");
    expect(v.toLowerCase()).toContain("сорок");
  });
});

function session() {
  const sendAction = vi.fn(async (): Promise<ActionResult> => ({ commandId: "c", ok: true, durationMs: 1 }));
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}
function deps(llm: MockLlmProvider, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
    ...over,
  } as unknown as AgentDeps;
}

describe("петлёй (handleUserText): без модели и без фоновой задачи", () => {
  it.each([
    ["Джарвис, ты меня слышишь?", "Слышу, сэр."],
    ["Джарвис.", "Слушаю, сэр."],
    ["Прием.", "На связи, сэр."],
    ["Джарвис, ты тут?", "Тут, сэр."],
  ])("«%s» → «%s», LLM не вызывался, задач нет", async (text, voice) => {
    const llm = new MockLlmProvider([{ text: "не должно вызваться" }]);
    const d = deps(llm);
    const reply = await handleUserText(session(), text, d);
    expect(reply.voice).toBe(voice);
    expect(llm.requests).toHaveLength(0);
    expect(d.tasks?.activeForUser("u1", undefined, false) ?? []).toHaveLength(0);
  });

  it("L3: висит уточнение консьержа («Рекомендации или конкретное видео?») — «Джарвис, ты тут?» не перехватывается", async () => {
    const llm = new MockLlmProvider([{ text: "Да, сэр." }]);
    const d = deps(llm);
    d.pendingClarify = { key: "youtube" };
    const reply = await handleUserText(session(), "Джарвис, ты тут?", d);
    expect(reply.voice).not.toBe("Тут, сэр.");
  });

  it("ответ идёт в рабочую память диалога", async () => {
    const d = deps(new MockLlmProvider());
    await handleUserText(session(), "Джарвис, ты меня слышишь?", d);
    expect(d.memory.recentTurns().map((t) => t.text)).toContain("Слышу, сэр.");
  });

  it("реплика окна БЕЗ «Джарвис» (фон, viaWake=false) — прежним путём: в модель", async () => {
    const llm = new MockLlmProvider([{ text: "Слышу." }]);
    await handleUserText(session(), "ты меня слышишь?", deps(llm), undefined, { viaWake: false });
    expect(llm.requests.length).toBeGreaterThan(0);
  });

  it("настоящая команда с обращением — в модель, как и прежде", async () => {
    const llm = new MockLlmProvider([{ text: "Готово, сэр." }]);
    await handleUserText(session(), "Джарвис, расскажи анекдот про тесты", deps(llm));
    expect(llm.requests.length).toBeGreaterThan(0);
  });

  it("productMode: время не отвечаем часами сервера (арендатор в другом часовом поясе) — в модель", async () => {
    const llm = new MockLlmProvider([{ text: "Не знаю часовой пояс." }]);
    await handleUserText(session(), "Джарвис, сколько времени?", deps(llm, { productMode: true }));
    expect(llm.requests.length).toBeGreaterThan(0);
  });
});

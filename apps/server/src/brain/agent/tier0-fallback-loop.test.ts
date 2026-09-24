/**
 * Причина №1 из USER_SCENARIOS_2026-09-02: tier0 «открой/запусти X» с неизвестным именем умирал честным
 * «не нашёл» БЕЗ отката в модель — «запусти тесты»-класс не работал вовсе. Проверяем ПЕТЛЁЙ:
 * app.launch → not_found → модель получает ход. Ревью 2026-09-24 (T-F5): ЛЮБОЙ провал запуска (timeout,
 * launch_failed) тоже уходит модели — с причиной во врезке контекста; фраза без модели называет причину.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { failurePhrase } from "../verbalize/action-phrases.js";
import { type AgentDeps, handleUserText } from "./index.js";
import { SelectionSlot } from "./selection-context.js";

function session(code: "not_found" | "timeout" | "overlay_drawing" | "launch_failed") {
  const sendAction = vi.fn((cmd: ActionCommand) =>
    Promise.resolve(
      cmd.kind === "app.launch"
        ? { commandId: "c", ok: false, error: { code, message: code === "not_found" ? "не нашёл" : code === "overlay_drawing" ? "Поверх экрана открыт оверлей режима выделения" : code === "launch_failed" ? "не удалось запустить «дискорд»: process-exited-immediately exit=0" : "превышен таймаут" }, durationMs: 1 }
        : { commandId: "c", ok: true, durationMs: 1 },
    ),
  );
  return { session: { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session, sendAction };
}

function deps(llm: MockLlmProvider): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
  };
}

describe("tier0 app.launch не нашёл цель → ход уходит модели (не терминал «не нашёл»)", () => {
  it("«открой тикетов» (tier0 app.launch) + not_found → модель вызвана, реплика — от модели", async () => {
    const { session: s, sendAction } = session("not_found");
    const llm = new MockLlmProvider([{ text: "Такого приложения нет, сэр — открыл бы через поиск, если уточните." }]);
    const reply = await handleUserText(s, "открой тикетов", deps(llm));
    expect(sendAction).toHaveBeenCalledTimes(1); // tier0 попробовал
    expect(llm.requests.length).toBeGreaterThanOrEqual(1); // …и передал модели
    expect(reply.voice).toContain("Такого приложения нет");
    expect(reply.voice).not.toMatch(/не нашёл/u);
  });

  it("контроль-8 (tier0-overlay-reason): отказ вуали — ЧЕСТНАЯ причина владельцу и ход модели, а не пустое «не получилось»", async () => {
    const { session: s } = session("overlay_drawing");
    const llm = new MockLlmProvider([{ text: "Дождусь, пока вы закончите с рамкой, сэр, и открою." }]);
    const reply = await handleUserText(s, "открой тикетов", deps(llm));
    expect(llm.requests.length).toBeGreaterThanOrEqual(1); // до фикса: ход модели не отдавался вовсе
    expect(reply.voice).toContain("Дождусь");
    // Саму формулировку проверяем НАПРЯМУЮ: через петлю её не слышно (ход уходит модели), и ассерт по reply.voice
    // проходил бы и с откаченным фиксом — первая версия теста была из-за этого декоративной.
    const phrase = failurePhrase({ kind: "app.launch", app: "тикетов" }, "overlay_drawing");
    expect(phrase).toMatch(/режим выделения/u);
    expect(phrase).not.toMatch(/не получилось/u);
  });

  it("T-F5: таймаут запуска → тоже ход модели, и во врезке — «исход неизвестен, сверь окна, вслепую не повторяй»", async () => {
    // Реверт: верни в runLocalIntent условие `code === "not_found"` — модель не вызовется (llm.requests пуст).
    const { session: s } = session("timeout");
    const llm = new MockLlmProvider([{ text: "Сверю, открылось ли, сэр." }]);
    const reply = await handleUserText(s, "открой тикетов", deps(llm));
    expect(llm.requests.length).toBeGreaterThanOrEqual(1);
    const ctxText = JSON.stringify(llm.requests[0]?.messages ?? []);
    expect(ctxText).toContain("timeout");
    expect(ctxText).toMatch(/Исход НЕИЗВЕСТЕН/u);
    expect(reply.voice).toContain("Сверю");
  });

  it("T-F5: «открой дискорд» — ярлык запустился и сразу закрылся (launch_failed) → модель получает причину и доводит", async () => {
    const { session: s, sendAction } = session("launch_failed");
    const llm = new MockLlmProvider([{ text: "Ярлык Дискорда пустой, сэр — запускаю через Update.exe с --processStart." }]);
    const reply = await handleUserText(s, "открой дискорд", deps(llm));
    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(llm.requests.length).toBeGreaterThanOrEqual(1);
    // Причина — в контексте хода модели (служебной врезкой), а не выброшена.
    expect(JSON.stringify(llm.requests[0]?.messages ?? [])).toContain("process-exited-immediately");
    expect(reply.voice).toContain("processStart");
  });

  it("T-F5: без модели (фоновый путь озвучивает voice как есть) фраза провала НАЗЫВАЕТ причину, а не «не получилось»", async () => {
    // Реверт: верни `failurePhrase(intent, code)` в runLocalIntent — прозвучит «не получилось».
    const { session: s } = session("launch_failed");
    const spoken: string[] = [];
    const llm = new MockLlmProvider([]);
    await handleUserText(s, "открой дискорд", { ...deps(llm), speakResult: (r) => spoken.push(r.voice) });
    await vi.waitFor(() => expect(spoken.length).toBe(1), { timeout: 2000 });
    expect(spoken[0]).toMatch(/сразу закрылась/u);
    expect(spoken[0]).not.toMatch(/не получилось/u);
  });
});

// Контроль-9 (clarify-path-ignores-fallback): ветка ОТВЕТА НА УТОЧНЕНИЕ использовала исход tier0 как есть —
// в отличие от основной ветки, где откат в модель и заведён. Под вуалью (browser.open режется гейтом) ход
// модели не отдавался вовсе: довести дело после закрытия рамки было некому.
describe("ответ на уточнение консьержа тоже уважает откат в модель", () => {
  it("«рекомендации» после вопроса про ютуб + отказ вуали → ход уходит модели", async () => {
    const sendAction = vi.fn((cmd: ActionCommand) =>
      Promise.resolve(
        cmd.kind === "browser.open" || cmd.kind === "app.launch"
          ? { commandId: "c", ok: false, error: { code: "overlay_drawing" as const, message: "Поверх экрана открыт оверлей режима выделения" }, durationMs: 1 }
          : { commandId: "c", ok: true, durationMs: 1 },
      ),
    );
    const s = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
    const llm = new MockLlmProvider([{ text: "Открою ютуб, как закроете рамку, сэр." }]);
    const d = deps(llm);
    d.pendingClarify = { key: "youtube" };
    const reply = await handleUserText(s, "рекомендации", d);
    expect(llm.requests.length).toBeGreaterThanOrEqual(1); // до фикса: 0 — ход модели не отдавался
    expect(reply.voice).toContain("Открою ютуб");
  });
});

// Контроль-10 (tier0-openorfocus-no-veil-gate): ОСНОВНОЙ путь «Джарвис, открой ютуб» — tier0, и до модели он не
// доходит. При подключённом расширении он звал openOrFocus без гейта вуали: окно Chrome вставало поверх окна
// рисования и забирало у владельца Esc.
describe("tier0 browser.open через расширение под вуалью", () => {
  it("идёт рисование → вкладку НЕ поднимаем, ход уходит модели", async () => {
    const { session: s } = session("not_found");
    const openOrFocus = vi.fn(async () => ({ focused: true }));
    const llm = new MockLlmProvider([{ text: "Открою, как закроете рамку, сэр." }]);
    const slot = new SelectionSlot();
    slot.setDrawing(true);
    const reply = await handleUserText(s, "открой ютуб", { ...deps(llm), openOrFocus, selection: slot });
    expect(openOrFocus).not.toHaveBeenCalled();
    expect(llm.requests.length).toBeGreaterThanOrEqual(1);
    expect(reply.voice).toContain("Открою");
  });

  it("вуали нет → прежний путь через расширение (модель не зовётся)", async () => {
    const { session: s } = session("not_found");
    const openOrFocus = vi.fn(async () => ({ focused: false }));
    const llm = new MockLlmProvider([{ text: "не должно вызваться" }]);
    const reply = await handleUserText(s, "открой ютуб", { ...deps(llm), openOrFocus });
    expect(openOrFocus).toHaveBeenCalledTimes(1);
    expect(llm.requests).toHaveLength(0);
    expect(reply.voice ?? "").toMatch(/Открыл/u);
  });
});

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

  // Контроль-1 №4 (ревью 2026-09-24): ГОЛОСОВОЙ путь. exe-запуск ждёт сверки ~1,5 с → «открой дискорд» промотируется
  // («Секунду, сэр»), и провал приходил уже в фоне — там fallbackToLlm игнорировался, модель не звалась.
  // Реверт: убери ветку `reply.fallbackToLlm` в bg.then (runTier0) — модель не вызовется, прозвучит «не смог».
  it("голосовой путь: провал запуска ПОСЛЕ промоушена → модель в фоне получает причину и доводит", async () => {
    vi.stubEnv("JARVIS_SYNC_PROMOTE_MS", "20");
    try {
      const sendAction = vi.fn(
        (cmd: ActionCommand) =>
          new Promise((res) =>
            setTimeout(
              () =>
                res(
                  cmd.kind === "app.launch"
                    ? { commandId: "c", ok: false, error: { code: "launch_failed", message: "не удалось запустить «дискорд»: process-exited-immediately exit=0" }, durationMs: 60 }
                    : { commandId: "c", ok: true, durationMs: 1 },
                ),
              60,
            ),
          ),
      );
      const s = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
      const spoken: string[] = [];
      const llm = new MockLlmProvider([{ text: "Запустил Дискорд через Update.exe, сэр." }]);
      const sink = { sentence: vi.fn(), display: vi.fn(), done: vi.fn() };
      const d = { ...deps(llm), speakResult: (r: { voice: string }) => spoken.push(r.voice), bgTasks: new Set<Promise<void>>() };
      const reply = await handleUserText(s, "открой дискорд", d, sink);
      expect(reply.voice).toMatch(/Секунду/u); // промоушен случился
      await vi.waitFor(() => expect(spoken.some((v) => /Update\.exe/u.test(v))).toBe(true), { timeout: 3000 });
      expect(JSON.stringify(llm.requests[0]?.messages ?? [])).toContain("process-exited-immediately");
      expect(spoken.some((v) => /Не смог запустить|сразу закрылась/u.test(v))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Контроль-2 №2: фоновый ход после промоушена обязан нести признаки хода. Реплика из окна разговора (viaWake:false)
  // не даёт права на слепой реплей макроса (§P0). Реверт: убери `...turn` в bg.then (runTier0) — уйдёт skill.execute.
  it("после промоушена реплика без «Джарвис» (viaWake:false) не получает слепой реплей макроса", async () => {
    vi.stubEnv("JARVIS_SYNC_PROMOTE_MS", "20");
    try {
      const sendAction = vi.fn(
        (cmd: ActionCommand) =>
          new Promise((res) =>
            setTimeout(
              () =>
                res(
                  cmd.kind === "app.launch"
                    ? { commandId: "c", ok: false, error: { code: "launch_failed", message: "process-exited-immediately" }, durationMs: 60 }
                    : { commandId: "c", ok: true, durationMs: 1 },
                ),
              cmd.kind === "app.launch" ? 60 : 1,
            ),
          ),
      );
      const s = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
      const skills = {
        list: async () => [],
        get: async () => null,
        save: async () => null,
        recall: async () => ({
          id: "sk-discord",
          name: "Открыть дискорд и зайти в канал",
          when: "просят открыть дискорд",
          procedure: "…",
          version: 1,
          recallSim: 0.97,
          recallSimRaw: 0.9,
          steps: [
            { action: "input.key", params: { combo: "ctrl+k" } },
            { action: "wait", params: { ms: 300 } },
          ],
        }),
        recordOutcome: async () => undefined,
      } as unknown as AgentDeps["skills"];
      const llm = new MockLlmProvider([{ text: "Не смог открыть Дискорд, сэр: ярлык сразу закрылся." }]);
      const spoken: string[] = [];
      const sink = { sentence: vi.fn(), display: vi.fn(), done: vi.fn() };
      const d = { ...deps(llm), skills, speakResult: (r: { voice: string }) => spoken.push(r.voice), bgTasks: new Set<Promise<void>>() };
      await handleUserText(s, "открой дискорд", d, sink, { viaWake: false });
      await vi.waitFor(() => expect(spoken.length).toBeGreaterThan(0), { timeout: 3000 });
      const kinds = sendAction.mock.calls.map((c) => (c[0] as ActionCommand).kind);
      expect(kinds).toContain("app.launch");
      expect(kinds).not.toContain("skill.execute");
    } finally {
      vi.unstubAllEnvs();
    }
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

/**
 * Async-контур (§20): аренда ввода (параллельные задачи без коллизий за мышь/клаву),
 * фон при занятом вводе для tier0, LLM-голос дворецких подтверждений.
 *
 * Ключевая инвариантность: GUI-команды (app.launch и т.п.) НИКОГДА не пересекаются во
 * времени между параллельными задачами — их сериализует AsyncMutex; не-GUI команды
 * (fs.read и т.п.) идут параллельно — ввод не трогают.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { AsyncMutex } from "@jarvis/shared";
import { SpendGuard } from "../../billing/index.js";
import {
  type ILlmProvider,
  type LlmDelta,
  type LlmRequest,
  type LlmResponse,
  MockLlmProvider,
  streamViaComplete,
} from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import type { Session } from "../../gateway/session.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

const ZERO_USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };

/**
 * LLM-мок, решающий по СОДЕРЖИМОЮ запроса (а не глобальному счётчику) — чтобы
 * параллельные задачи со своими диалогами не путали скрипт друг друга. Первый ход
 * (нет tool_result в истории) → запросить инструмент `tool`; далее → финальный текст.
 */
function toolThenText(tool: string, input: Record<string, unknown>): ILlmProvider {
  let n = 0;
  const provider: ILlmProvider = {
    live: false,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const hasResult = req.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
      );
      if (!hasResult) {
        n += 1;
        return {
          text: "",
          toolUses: [{ id: `t${n}`, name: tool, input }],
          stopReason: "tool_use",
          usage: ZERO_USAGE,
          stubbed: true,
        };
      }
      return { text: "Готово, сэр.", toolUses: [], stopReason: "end_turn", usage: ZERO_USAGE, stubbed: true };
    },
    completeStream(req: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
      return streamViaComplete(provider, req, onDelta);
    },
  };
  return provider;
}

/** Сессия с sendAction, который замеряет пересечение во времени input-vs-нет команд. */
function trackingSession(opts: { delayMs: number }) {
  let inFlightInput = 0;
  const overlap = { input: false };
  const calls: ActionCommand[] = [];
  const sendAction = vi.fn(async (cmd: ActionCommand) => {
    calls.push(cmd);
    const isInput = cmd.kind === "app.launch";
    if (isInput) {
      inFlightInput += 1;
      if (inFlightInput > 1) overlap.input = true;
    }
    await new Promise((r) => setTimeout(r, opts.delayMs));
    if (isInput) inFlightInput -= 1;
    return { commandId: "c", ok: true, durationMs: 1 };
  });
  const session = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn() } as unknown as Session & {
    sendAction: typeof sendAction;
  };
  return { session, overlap, calls };
}

function makeDeps(llm: ILlmProvider, overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    bgTasks: new Set(),
    ...overrides,
  };
}

describe("async-контур §20: аренда ввода и параллелизм", () => {
  it("параллельные GUI-задачи НЕ дерутся за ввод (аренда сериализует app.launch)", async () => {
    const { session, overlap, calls } = trackingSession({ delayMs: 15 });
    const spoken: { voice: string }[] = [];
    const arbiter = new AsyncMutex();
    const deps = makeDeps(toolThenText("app_launch", { app: "x" }), {
      speakResult: (r) => spoken.push(r),
      inputArbiter: arbiter,
    });
    // Две многошаговые задачи подряд → обе уходят в фон и бегут «параллельно».
    await handleUserText(session, "создай файл номер один и настрой", deps);
    await handleUserText(session, "собери отчёт номер два и сохрани", deps);

    await vi.waitFor(() => expect(spoken.length).toBe(2), { timeout: 3000 });
    expect(calls.filter((c) => c.kind === "app.launch")).toHaveLength(2);
    expect(overlap.input).toBe(false); // аренда не дала GUI-командам пересечься
    expect(arbiter.locked).toBe(false); // аренда освобождена обеими задачами
  });

  it("независимые НЕ-GUI задачи бегут параллельно (аренда не блокирует fs.read)", async () => {
    // fs.read ввод не трогает → лиз не берётся → команды могут пересекаться во времени.
    let inFlight = 0;
    let peak = 0;
    const sendAction = vi.fn(async (_cmd: ActionCommand) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { commandId: "c", ok: true, durationMs: 1 };
    });
    const session = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn() } as unknown as Session;
    const spoken: { voice: string }[] = [];
    const deps = makeDeps(toolThenText("fs_read", { path: "x" }), {
      speakResult: (r) => spoken.push(r),
      inputArbiter: new AsyncMutex(),
    });
    await handleUserText(session, "найди номер один в файлах и собери", deps);
    await handleUserText(session, "проанализируй номер два и составь", deps);

    await vi.waitFor(() => expect(spoken.length).toBe(2), { timeout: 3000 });
    expect(peak).toBeGreaterThanOrEqual(2); // реально параллельно (ввод свободен)
  });

  it("tier0 с голосовым каналом → ФОН даже при свободной аренде (не блокируем слух, тихий финал)", async () => {
    // Регресс «перестаёт слышать»: медленный browser.open (CDP-таймаут 12с) инлайном держал
    // пайплайн в «думаю» → микрофон не кормился. Теперь tier0 всегда в фон: ход завершается ТИХО
    // (без немедленного ack), слух свободен, итог приходит по готовности (§20 тихий финал).
    const { session } = trackingSession({ delayMs: 30 });
    const spoken: { voice: string }[] = [];
    const arbiter = new AsyncMutex();
    const deps = makeDeps(new MockLlmProvider(), { inputArbiter: arbiter, speakResult: (r) => spoken.push(r) });
    const reply = await handleUserText(session, "открой ютуб", deps);
    expect(reply.voice).toBe(""); // тихий финал: НЕТ дубль-ack, фраза будет одна — результат
    // действие исполняется в фоне, итог проговаривается по готовности
    await vi.waitFor(() => expect(session.sendAction).toHaveBeenCalled(), { timeout: 3000 });
    await vi.waitFor(() => expect(spoken.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(spoken[0]?.voice.toLowerCase()).toMatch(/откр/); // формулировка ротируется (§11), но это «открыл»
    await vi.waitFor(() => expect(arbiter.locked).toBe(false), { timeout: 3000 }); // аренда освобождена
  });

  it("tier0 БЕЗ голосового канала (dev.text/тест) — инлайн под арендой", async () => {
    const { session } = trackingSession({ delayMs: 1 });
    const arbiter = new AsyncMutex();
    const deps = makeDeps(new MockLlmProvider(), { inputArbiter: arbiter }); // нет speakResult
    const reply = await handleUserText(session, "открой ютуб", deps);
    expect(session.sendAction).toHaveBeenCalledTimes(1);
    expect(reply.voice.toLowerCase()).toMatch(/откр/); // синхронный итог (формулировка ротируется §11)
    expect(arbiter.locked).toBe(false);
  });

  it("tier0 при ЗАНЯТОЙ аренде → тихий финал, действие в фон (фокус не украден)", async () => {
    const { session } = trackingSession({ delayMs: 1 });
    const spoken: { voice: string }[] = [];
    const arbiter = new AsyncMutex();
    arbiter.tryAcquire(); // имитируем: фоновая задача держит ввод
    const deps = makeDeps(new MockLlmProvider(), {
      inputArbiter: arbiter,
      speakResult: (r) => spoken.push(r),
    });
    const reply = await handleUserText(session, "открой телеграм", deps);
    expect(reply.voice).toBe(""); // тихий финал — без немедленного ack
    expect(session.sendAction).not.toHaveBeenCalled(); // фокус не тронут — ждём аренду

    arbiter.release(); // «фоновая задача освободила ввод»
    await vi.waitFor(() => expect(session.sendAction).toHaveBeenCalled(), { timeout: 3000 });
    const cmd = (session.sendAction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ActionCommand;
    expect(cmd.kind).toBe("browser.open");
    await vi.waitFor(() => expect(spoken.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(spoken[0]?.voice.toLowerCase()).toMatch(/откр/); // формулировка ротируется (§11)
  });

  it("отмена пока задача ждёт аренду ввода → GUI-команда НЕ исполняется (реактивная отмена §20)", async () => {
    const sendAction = vi.fn(async () => ({ commandId: "c", ok: true, durationMs: 1 }));
    const session = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn() } as unknown as Session;
    const arbiter = new AsyncMutex();
    arbiter.tryAcquire(); // «другая» задача держит ввод → наша упрётся в acquire перед app.launch
    const tasks = new TaskManager();
    const deps = makeDeps(toolThenText("app_launch", { app: "x" }), {
      speakResult: () => {},
      inputArbiter: arbiter,
      tasks,
    });
    await handleUserText(session, "создай файл и настрой систему", deps);
    // Задача ушла в фон, сделала первый ход LLM и заблокировалась на аренде перед app.launch.
    await vi.waitFor(() => expect(tasks.list("u1").length).toBe(1), { timeout: 3000 });
    const task = tasks.list("u1")[0]!;

    tasks.cancel(task.taskId); // отменяем, пока ждёт аренду
    arbiter.release(); // отдаём аренду — задача получит её, увидит cancel и НЕ выполнит app.launch

    await vi.waitFor(() => expect(tasks.get(task.taskId)?.state).toBe("cancelled"), { timeout: 3000 });
    expect(sendAction).not.toHaveBeenCalled(); // GUI-команда не ушла (фокус не тронут)
    expect(arbiter.locked).toBe(false); // аренда отдана, не утекла
  });

  it("§20 отмена ТИХАЯ: отменённая петля не озвучивает свой «Хорошо, остановил» (ack — у control-хендлера)", async () => {
    const spoken: { voice: string }[] = [];
    const sendAction = vi.fn(async () => ({ commandId: "c", ok: true, durationMs: 1 }));
    const session = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn() } as unknown as Session;
    const arbiter = new AsyncMutex();
    arbiter.tryAcquire();
    const tasks = new TaskManager();
    const deps = makeDeps(toolThenText("app_launch", { app: "x" }), {
      speakResult: (r: { voice: string }) => spoken.push(r),
      inputArbiter: arbiter,
      tasks,
    });
    await handleUserText(session, "создай файл и настрой систему", deps);
    await vi.waitFor(() => expect(tasks.list("u1").length).toBe(1), { timeout: 3000 });
    const task = tasks.list("u1")[0]!;
    tasks.cancel(task.taskId);
    arbiter.release();
    await vi.waitFor(() => expect(tasks.get(task.taskId)?.state).toBe("cancelled"), { timeout: 3000 });
    // Раньше: терминал возвращал «Хорошо, остановил.» → speakResult → на N задачах N голосов.
    expect(spoken.some((s) => /остановил/i.test(s.voice))).toBe(false);
  });

  it("§20 тихий финал: содержательный ход = ОДНА фраза (результат), без дубль-ack", async () => {
    // Корень жалобы «×2-3 фразы на ВСЕХ ходах»: дворецкий ack звучал БЕЗУСЛОВНО + результат следом.
    // Теперь ход завершается тихо ({voice:""}), а единственная произносимая фраза — сам результат.
    const { session } = trackingSession({ delayMs: 1 });
    const spoken: { voice: string }[] = [];
    const deps = makeDeps(toolThenText("fs_read", { path: "x" }), {
      speakResult: (r) => spoken.push(r),
      inputArbiter: new AsyncMutex(),
    });
    const reply = await handleUserText(session, "найди номер один в файлах и собери", deps);
    expect(reply.voice).toBe(""); // тихий финал — без немедленного ack
    await vi.waitFor(() => expect(spoken.length).toBeGreaterThan(0), { timeout: 3000 });
    // Дать осесть любым отложенным колбэкам: лишних фраз (ack) появиться НЕ должно.
    await new Promise((r) => setTimeout(r, 30));
    expect(spoken).toHaveLength(1); // ровно результат, без «Принял»
  });
});

describe("§20 отложенный ack долгой фоновой задачи (аудит лога 2026-07-03)", () => {
  // «прекрати поиск у доти» шла 33с в полной тишине → пользователь снял её вручную, не зная,
  // идёт ли она. Теперь: задача дольше JARVIS_TASK_ACK_MS без единой фразы → ОДИН прогресс-маячок.
  const ENV = "JARVIS_TASK_ACK_MS";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it("долгая задача → один «Занимаюсь…» ДО итога; итог звучит как раньше", async () => {
    process.env[ENV] = "30"; // порог ниже длительности инструмента (120мс)
    const { session } = trackingSession({ delayMs: 120 });
    const spoken: { voice: string }[] = [];
    const deps = makeDeps(toolThenText("app_launch", { app: "x" }), {
      speakResult: (r) => spoken.push(r),
      inputArbiter: new AsyncMutex(),
    });
    await handleUserText(session, "создай файл и настрой систему", deps);
    await vi.waitFor(() => expect(spoken.length).toBe(2), { timeout: 3000 });
    expect(spoken[0]?.voice).toContain("Занимаюсь"); // маячок пришёл ПЕРВЫМ, пока шла работа
    expect(spoken[1]?.voice).toContain("Готово"); // итог не задублирован и не подменён
    // Осесть отложенным колбэкам: второго маячка быть не должно (одноразовый).
    await new Promise((r) => setTimeout(r, 80));
    expect(spoken).toHaveLength(2);
  });

  it("cancel-safe: отменённая задача НЕ получает маячок (ретро ButlerAcks — таймер видит cancel)", async () => {
    process.env[ENV] = "60";
    const sendAction = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { commandId: "c", ok: true, durationMs: 1 };
    });
    const session = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn() } as unknown as Session;
    const spoken: { voice: string }[] = [];
    const tasks = new TaskManager();
    const deps = makeDeps(toolThenText("app_launch", { app: "x" }), {
      speakResult: (r: { voice: string }) => spoken.push(r),
      inputArbiter: new AsyncMutex(),
      tasks,
    });
    await handleUserText(session, "создай файл и настрой систему", deps);
    await vi.waitFor(() => expect(tasks.list("u1").length).toBe(1), { timeout: 3000, interval: 5 });
    tasks.cancel(tasks.list("u1")[0]!.taskId); // отмена ДО срабатывания таймера (60мс)
    // Ждём дольше порога ack + завершение петли: ни маячка, ни «остановил» от петли (тихая отмена).
    await new Promise((r) => setTimeout(r, 450));
    expect(spoken).toHaveLength(0);
  });

  it("быстрая задача (короче порога) — маячка нет, только итог (тихий финал не сломан)", async () => {
    process.env[ENV] = "500"; // порог заведомо больше длительности задачи
    const { session } = trackingSession({ delayMs: 10 });
    const spoken: { voice: string }[] = [];
    const deps = makeDeps(toolThenText("fs_read", { path: "x" }), {
      speakResult: (r) => spoken.push(r),
      inputArbiter: new AsyncMutex(),
    });
    await handleUserText(session, "найди номер один в файлах и собери", deps);
    await vi.waitFor(() => expect(spoken.length).toBe(1), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 550)); // пережить порог: очищенный таймер не должен стрельнуть
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.voice).not.toContain("Занимаюсь");
  });
});

/**
 * 🔴 Разбор эпизода «Дота» (2026-09-02, MED→структурная нечестность): ход, который ВСЛУХ сказал
 * владельцу «Задача не выполнена, сэр: … ввод мне не отдают», лежал в реестре как `state:"done"`,
 * а в метриках как `ok:true`. Врала не модель — врала телеметрия: отказ аренды физического ввода
 * кладётся обычным `is_error`-блоком, а `failed` взводится только на исключении петли.
 *
 * Цена: `self/weaknesses.ts` считает провалы по `ok === false` — на просьбу «проанализируй, почему
 * ты медленный» система смотрит в данные, где этот ход помечен успехом. Плюс тем же `taskOk`
 * гейтится САМООБУЧЕНИЕ: провальная траектория могла осесть навыком (в эпизоде спасло лишь то, что
 * в ходе сработал recall).
 *
 * Проверяем ПЕТЛЁЙ (правило проекта): чистая функция тут ничего не доказала бы.
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
import { type AgentDeps, handleUserText } from "./index.js";

function session() {
  return {
    sessionId: "s1",
    userId: "u1",
    sendAction: vi.fn((_c: ActionCommand) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 })),
    send: vi.fn(),
    requestConfirm: vi.fn(),
  } as unknown as Session;
}

/** Аренда ввода, которую НИКОГДА не дают (её держит другая задача Джарвиса). */
const busyArbiter = () =>
  ({
    locked: true,
    acquireWithTimeout: async () => false,
    acquire: async () => undefined,
    release: () => undefined,
  }) as unknown as AgentDeps["inputArbiter"];

function deps(llm: MockLlmProvider, tasks: TaskManager, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks,
    inputArbiter: busyArbiter(),
    ...over,
  } as AgentDeps;
}

describe("отказ аренды ввода = НЕ успех задачи", () => {
  it("клик не сделан (ввод занят), модель честно доложила → задача помечена ПРОВАЛЕННОЙ", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "input_click", input: { target: { by: "coords", x: 100, y: 200 } } }] },
      { text: "Задача не выполнена, сэр: ввод занят другой задачей." },
    ]);
    await handleUserText(session(), "нажми кнопку играть", deps(llm, tasks));
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed"); // до фикса: "done" при вслух сказанном «не выполнена»
    expect(t?.lastError ?? "").toMatch(/ввод занят/);
  });

  it("отказ аренды пережили и добились СВОЕГО другим путём → это по-прежнему успех", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } }] },
      // Мутирующее действие БЕЗ аренды ввода прошло (system.* мышь не занимает) — ход состоялся.
      { toolUses: [{ id: "v1", name: "system_volume", input: { op: "up" } }] },
      { text: "Открыл, сэр." },
    ]);
    // Текст тот же: «открой сайт» ушло бы детерминированным tier0 и задачи в реестре не создало.
    await handleUserText(session(), "нажми кнопку играть", deps(llm, tasks));
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("done"); // гард узкий: восстановившийся ход успехом остаётся
  });
});

/**
 * 🔴 Адверс-ревью этой же правки (2026-09-02, HIGH): признак ставился у ОДНОГО потребителя отказа
 * (tool-цикл), а их два — второй это БЫСТРЫЙ РЕПЛЕЙ макроса (§8), который ловит отказ своим catch.
 * Прогон ревьюера на боевом голосовом пути: реплей падает «ввод занят», модель отвечает текстом →
 * `state:"done"`, «Готово, сэр — поиск игры запущен», ok:true, и вдобавок навыку пишется УСПЕХ,
 * хотя не выполнилось ни шага. Признак перенесён в `ensureInput` — единственное место рождения отказа.
 */
describe("отказ аренды на пути АВТО-РЕПЛЕЯ макроса — тоже не успех", () => {
  it("реплей не получил аренду → задача не «done» и навыку не пишется успех", async () => {
    const tasks = new TaskManager();
    const outcomes: Array<{ id: string; success: boolean }> = [];
    const skills = {
      list: async () => [],
      get: async () => null,
      save: async () => null,
      recall: async () => ({
        id: "sk1",
        name: "Запустить поиск игры в Dota 2",
        when: "просят найти игру",
        procedure: "нажать ИГРАТЬ, затем НАЙТИ ИГРУ",
        version: 1,
        recallSim: 0.97,
        recallSimRaw: 0.9,
        steps: [
          { action: "app.focus", params: { app: "dota2" } },
          { action: "input.click", params: { x: 100, y: 200 } },
        ],
      }),
      recordOutcome: async (_u: string, id: string, success: boolean) => {
        outcomes.push({ id, success });
      },
    } as unknown as AgentDeps["skills"];
    const llm = new MockLlmProvider([{ text: "Готово, сэр — поиск игры запущен." }]);
    // 🔴 sink ОБЯЗАТЕЛЕН: это ГОЛОСОВОЙ путь (sync-first). На фоновом пути занятую аренду ловит
    // раньше admission-очередь (честный queueTimedOut) — и дефект прячется. Ровно это ревью и
    // показало: очередь гейтится `!sink`, а живая голосовая команда идёт с ним.
    const sink = { sentence: () => undefined, display: () => undefined, done: () => undefined };
    // Фраза с командным глаголом и НЕ детерминированная (иначе tier0 заберёт ход и задачи не будет).
    await handleUserText(session(), "нажми кнопку играть в доте", deps(llm, tasks, { skills }), sink, { viaWake: true });
    const t = tasks.toJSON().tasks[0];
    expect(t).toBeDefined(); // без задачи ассерт ниже был бы декоративным
    expect(t?.lastError ?? "").toMatch(/ввод занят другой задачей — действие не выполнено/); // именно наша ветка
    expect(t?.state).toBe("failed"); // до фикса: done + «Готово», хотя не выполнилось ни шага
    expect(outcomes.filter((o) => o.success)).toHaveLength(0); // и навык не получает успех за чужую очередь
  });
});

/**
 * Довесок по адверс-ревью 2026-09-02 (MED-класс): признак «ввод не дали» не должен ни пачкать
 * соседние механизмы, ни молчать там, где владелец услышит успех.
 */
describe("отказ аренды: границы признака", () => {
  it("владелец ПОПРАВИЛ цель на ходу → провал по отменённой цели не приписывается новой", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } }] },
      { text: "В новостях сегодня спокойно, сэр." },
    ]);
    // Правку цели впрыскиваем ИЗ САМОГО отказа аренды — так она гарантированно сливается перед
    // раундом 2 (живой steer приходит ровно в это окно: владелец видит, что Джарвис встал).
    const arbiter = {
      locked: true,
      acquireWithTimeout: async () => {
        const cur = tasks.toJSON().tasks[0];
        if (cur) tasks.steer(cur.taskId, "не надо кнопку — просто скажи, что в новостях");
        return false;
      },
      acquire: async () => undefined,
      release: () => undefined,
    } as unknown as AgentDeps["inputArbiter"];
    await handleUserText(session(), "нажми кнопку играть", deps(llm, tasks, { inputArbiter: arbiter }));
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("done"); // до фикса: failed за отказ по ОТМЕНЁННОЙ цели
  });

  it("владелец СЛЫШИТ, что действие не сделано, даже если модель сказала «Готово»", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } }] },
      { text: "Готово, сэр — нажал «Играть», поиск игры запущен." }, // 6 слов: isHollowSuccess молчит
    ]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    await handleUserText(session(), "нажми кнопку играть", deps(llm, tasks), sink);
    expect(said.join(" ")).toMatch(/не сделал/); // честная оговорка добавлена к реплике модели
  });

  it("навык, поднятый recall'ом, не получает провал за чужую очередь", async () => {
    const tasks = new TaskManager();
    const outcomes: boolean[] = [];
    const skills = {
      list: async () => [],
      get: async () => null,
      save: async () => null,
      recall: async () => ({ id: "sk1", name: "Навык", when: "когда-то", procedure: "шаги", version: 1, recallSim: 0.85, recallSimRaw: 0.8 }),
      recordOutcome: async (_u: string, _id: string, ok: boolean) => {
        outcomes.push(ok);
      },
    } as unknown as AgentDeps["skills"];
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } }] },
      { text: "Не вышло, сэр." },
    ]);
    await handleUserText(session(), "нажми кнопку играть", deps(llm, tasks, { skills }));
    expect(outcomes).toHaveLength(0); // ни провала, ни успеха: навык не работал
  });
});

/**
 * 🔴 ШТОРМ ПАРАЛЛЕЛЬНОСТИ (лог 2026-09-02, вечер): при потолке MAX_PARALLEL_TASKS=3 одновременно шли
 * ШЕСТЬ задач. Причина: слот берёт только action-путь (runActionSyncFirst), а РАЗГОВОРНЫЙ ход не брал
 * никогда — хотя с инструментами он идёт минутами (в логе: «вопрос — разговор», 6 раундов, 127 с).
 * Семафор врал о занятости, и следующая команда стартовала поверх. Итог — очередь озвучки не
 * успевала, и за десять минут владелец не услышал девять реплик.
 */
describe("разговорный ход с инструментами занимает слот параллельности", () => {
  it("во время tool-раундов слот ЗАНЯТ, после терминала — освобождён", async () => {
    const { Semaphore } = await import("@jarvis/shared");
    const sem = new Semaphore(1);
    const tasks = new TaskManager();
    let releaseAction: (() => void) | undefined;
    const s = {
      sessionId: "s1",
      userId: "u1",
      send: vi.fn(),
      requestConfirm: vi.fn(),
      sendAction: vi.fn(
        () =>
          new Promise((res) => {
            releaseAction = () => res({ commandId: "c", ok: true, durationMs: 1, data: { text: "ок" } });
          }),
      ),
    } as unknown as Session;
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "w1", name: "window_list", input: {} }] },
      { text: "Окон три, сэр." },
    ]);
    const d = { ...deps(llm, tasks), concurrency: sem, inputArbiter: undefined } as AgentDeps;
    const p = handleUserText(s, "джарвис, какие окна открыты?", d, undefined, {});
    await new Promise((r) => setTimeout(r, 30)); // дошли до tool-раунда
    expect(sem.tryAcquire()).toBe(false); // слот держит разговорный ход — потолок видит правду
    releaseAction?.();
    await p;
    expect(sem.tryAcquire()).toBe(true); // и отдан на терминале
  });
});

/**
 * 🔴 «Отдельное решение на время подписки» (владелец, 2026-09-02). Потолок задачи 240 с калиброван под
 * ОСНОВНОЙ канал с prompt-кешем (раунд — доли секунды). У резерва кеша нет: замер по логу дня —
 * медиана 4.9 с, p90 14.9 с на раунд, и 22-шаговая GUI-задача в 240 с физически не влезает.
 * Потолок считается ФУНКЦИЕЙ (канал выясняется первым обращением к модели, и может смениться посреди
 * задачи), поэтому проверяем через метрику `capMs` реальной петли.
 */
describe("потолок задачи зависит от канала", () => {
  async function capFor(primary: "ok" | "off"): Promise<number> {
    const { metrics } = await import("../../obs/metrics.js");
    let cap = 0;
    const spy = vi.spyOn(metrics, "record").mockImplementation((e) => {
      cap = Number((e as unknown as { capMs?: number }).capMs ?? 0) || cap;
    });
    try {
      const tasks = new TaskManager();
      const llm = new MockLlmProvider([{ text: "Готово." }]);
      (llm as unknown as { channelStatus: () => unknown }).channelStatus = () => ({ primary, subscriptionLive: true });
      await handleUserText(session(), "нажми кнопку играть", { ...deps(llm, tasks), inputArbiter: undefined } as AgentDeps);
      return cap;
    } finally {
      spy.mockRestore();
    }
  }

  it("основной канал жив → прежние 240 с; выключен → шире (деф ×2)", async () => {
    expect(await capFor("ok")).toBe(240_000); // на живом канале поведение байт-в-байт прежнее
    expect(await capFor("off")).toBe(480_000);
  });
});

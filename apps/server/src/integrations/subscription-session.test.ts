// W2 «Мозг быстрый» (2026-09-09): непрерывная сессия SDK на подписке — одна query() на задачу, наш
// MCP-хендлер ждёт результат agent-loop, следующий ход идёт в той же сессии. Тесты гоняют РЕАЛЬНЫЙ
// провайдер против поддельного SDK, который ведёт себя как настоящий: зовёт хендлер после tool_use и
// продолжает только после его ответа. Каждый кейс проверен реверт-мутацией (снимаешь мост — падает).
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionLlmProvider, type SdkModule, continuationOutcomes } from "./subscription-llm.js";
import { SubscriptionSession, matchKey, toMcpResult } from "./subscription-session.js";
import type { LlmMessage, LlmRequest } from "./llm.js";

const APP_LAUNCH = { name: "app_launch", description: "запуск", input_schema: { type: "object", properties: {} } };
const BASE: LlmRequest = {
  tier: "sonnet",
  model: "claude-sonnet-4-6",
  systemStatic: "ПЕРСОНА",
  systemDynamic: "КОНТЕКСТ",
  messages: [{ role: "user", content: "запусти блокнот" }],
  tools: [APP_LAUNCH],
  sessionKey: "task-1",
};

type FakeTool = { name: string; handler: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> };

interface FakeSdk extends SdkModule {
  queries: Array<{ prompt: unknown; options: Record<string, unknown>; abort: AbortController }>;
  handlerResults: unknown[];
  /** Пауза между tool_use и вызовом хендлера (эмулирует порядок событий SDK). */
  handlerDelayMs: number;
  /** Завершить сессию ошибкой после результата инструмента. */
  failAfterTool?: string;
  /** Не слать message_stop после tool_use (старый SDK / потерянное событие) — проверка страховки. */
  noMessageStop?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Поддельный SDK «как настоящий»: tool_use → ждёт хендлер → текстовый ход с эхом результата → result. */
function realisticSdk(): FakeSdk {
  const sdk: FakeSdk = {
    queries: [],
    handlerResults: [],
    handlerDelayMs: 0,
    tool: (name, _d, _s, handler) => ({ name, handler }) as FakeTool,
    createSdkMcpServer: (opts) => ({ type: "sdk", name: opts.name, tools: opts.tools, timeout: opts.timeout }),
    query({ prompt, options }) {
      const abort = options.abortController as AbortController;
      const rec = { prompt, options, abort };
      sdk.queries.push(rec);
      const server = (options.mcpServers as Record<string, { tools: FakeTool[] }> | undefined)?.jarvis;
      return (async function* () {
        yield { type: "system", subtype: "init" };
        yield {
          type: "assistant",
          message: {
            id: "msg_1",
            usage: { input_tokens: 2, cache_creation_input_tokens: 100, output_tokens: 5 },
            content: [{ type: "tool_use", id: "t1", name: "mcp__jarvis__app_launch", input: { args: { app: "notepad" } } }],
          },
        };
        if (!sdk.noMessageStop) yield { type: "stream_event", event: { type: "message_stop" } };
        const tool = server?.tools.find((t) => t.name === "app_launch");
        if (!tool) return;
        if (sdk.handlerDelayMs > 0) await sleep(sdk.handlerDelayMs);
        const r = await tool.handler({ args: { app: "notepad" } });
        sdk.handlerResults.push(r);
        if (abort.signal.aborted) return;
        if (sdk.failAfterTool) {
          yield { type: "result", subtype: "error_during_execution", result: sdk.failAfterTool, usage: {} };
          return;
        }
        const echo = `Открыл: ${r.content.map((c) => c.text ?? `[${c.type}]`).join("|")}`;
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: echo } } };
        yield {
          type: "assistant",
          message: { usage: { input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 4 }, content: [{ type: "text", text: echo }] },
        };
        yield { type: "result", subtype: "success", usage: { input_tokens: 4, output_tokens: 9 } };
      })();
    },
  };
  return sdk;
}

/** История после первого хода: assistant(tool_use) + user(tool_result …). */
function continued(extra: LlmMessage["content"] extends string ? never : Array<{ type: "text"; text: string }> = []): LlmRequest {
  return {
    ...BASE,
    messages: [
      ...BASE.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "app_launch", input: { app: "notepad" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok, окно 42" }, ...extra] },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("W2: непрерывная сессия SDK (провайдер)", () => {
  it("второй раунд идёт в ТОЙ ЖЕ query: хендлер получает результат петли, CLI не пересоздаётся", async () => {
    const sdk = realisticSdk();
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    const first = await p.complete(BASE);
    expect(first.stopReason).toBe("tool_use");
    expect(first.toolUses).toEqual([{ id: "t1", name: "app_launch", input: { app: "notepad" } }]);
    expect(first.usage.cacheCreationTokens).toBe(100); // per-call числа SDK, не оценка
    expect(p.liveSessions).toBe(1);

    const second = await p.complete(continued());
    expect(sdk.queries).toHaveLength(1); // 🔴 суть W2: один процесс на задачу
    expect(sdk.handlerResults[0]).toEqual({ content: [{ type: "text", text: "ok, окно 42" }] });
    expect(second.text).toBe("Открыл: ok, окно 42");
    expect(second.stopReason).toBe("end_turn");
    expect(second.usage.cacheReadTokens).toBe(100); // история в кеше CLI
    expect(second.usage.inputTokens).toBe(2);
    expect(p.liveSessions).toBe(0); // текстовый финал завершил сессию
  });

  it("ДВА tool_use одного ответа (SDK шлёт их отдельными assistant-сообщениями с одним id) → ОДИН раунд петли, оба хендлера получают свои результаты", async () => {
    const results: string[] = [];
    const sdk: FakeSdk = {
      ...realisticSdk(),
      query({ options }) {
        const abort = options.abortController as AbortController;
        sdk.queries.push({ prompt: "", options, abort });
        const launch = ((options.mcpServers as Record<string, { tools: FakeTool[] }>).jarvis as { tools: FakeTool[] }).tools[0] as FakeTool;
        return (async function* () {
          const usage = { input_tokens: 2, output_tokens: 31 };
          yield { type: "assistant", message: { id: "msg_A", usage, content: [{ type: "tool_use", id: "a", name: "mcp__jarvis__app_launch", input: { args: { app: "x" } } }] } };
          // как настоящий CLI: хендлер первого блока зовётся ДО прихода второго блока
          const pa = launch.handler({ args: { app: "x" } }).then((r) => results.push("a:" + r.content[0]?.text));
          yield { type: "assistant", message: { id: "msg_A", usage, content: [{ type: "tool_use", id: "b", name: "mcp__jarvis__app_launch", input: { args: { app: "y" } } }] } };
          yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" } } };
          yield { type: "stream_event", event: { type: "message_stop" } };
          await pa;
          const rb = await launch.handler({ args: { app: "y" } });
          results.push("b:" + rb.content[0]?.text);
          if (abort.signal.aborted) return;
          yield { type: "assistant", message: { id: "msg_B", usage: { input_tokens: 2, output_tokens: 3 }, content: [{ type: "text", text: "Оба открыл." }] } };
          yield { type: "result", subtype: "success", usage: {} };
        })();
      },
    };
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    const first = await p.complete(BASE);
    expect(first.toolUses.map((u) => u.id)).toEqual(["a", "b"]); // один раунд с обоими вызовами
    expect(first.usage.outputTokens).toBe(31); // usage ответа посчитан один раз, не по блокам
    const second = await p.complete({
      ...BASE,
      messages: [
        ...BASE.messages,
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "app_launch", input: { app: "x" } }, { type: "tool_use", id: "b", name: "app_launch", input: { app: "y" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "окно x" }, { type: "tool_result", tool_use_id: "b", content: "окно y" }] },
      ],
    });
    expect(results).toEqual(["a:окно x", "b:окно y"]); // каждый хендлер — свой результат, в порядке CLI
    expect(second.text).toBe("Оба открыл.");
    expect(sdk.queries).toHaveLength(1);
  });

  it("без message_stop (потерянное событие) tool_use-ход всё равно отдаётся по страховочному таймеру", async () => {
    vi.useFakeTimers();
    const sdk = realisticSdk();
    sdk.noMessageStop = true;
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    const pending = p.complete(BASE);
    await vi.advanceTimersByTimeAsync(2100);
    const first = await pending;
    expect(first.toolUses.map((u) => u.id)).toEqual(["t1"]);
    p.release("task-1");
  });

  it("результат, пришедший РАНЬШЕ вызова хендлера, ждёт его (порядок событий SDK не гарантирован)", async () => {
    const sdk = realisticSdk();
    sdk.handlerDelayMs = 40;
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete(BASE);
    const second = await p.complete(continued());
    expect(sdk.queries).toHaveLength(1);
    expect(second.text).toBe("Открыл: ok, окно 42");
  });

  it("стрим продолжения: дельты уходят в onDelta, сумма дельт === text", async () => {
    const sdk = realisticSdk();
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete(BASE);
    let streamed = "";
    const second = await p.completeStream(continued(), (d) => {
      streamed += d.text;
    });
    expect(streamed).toBe(second.text);
    expect(streamed).toBe("Открыл: ok, окно 42");
  });

  it("врезка петли (нудж/поправка) в том же user-сообщении доносится хвостом результата, а не рвёт сессию", async () => {
    const sdk = realisticSdk();
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete(BASE);
    await p.complete(continued([{ type: "text", text: "⚡ПОПРАВКА: не блокнот, а wordpad" }]));
    expect(sdk.queries).toHaveLength(1);
    const delivered = sdk.handlerResults[0] as { content: Array<{ type: string; text?: string }> };
    expect(delivered.content.map((c) => c.text).join("\n")).toContain("ок, окно 42".replace("ок", "ok"));
    expect(delivered.content.map((c) => c.text).join("\n")).toContain("ПОПРАВКА");
    expect(delivered.content.map((c) => c.text).join("\n")).toContain("ВЛАДЕЛЕЦ/СИСТЕМА"); // размечено как не-вывод инструмента
  });

  it("картинка в tool_result доходит до модели MCP-блоком image (зрение в сессии, не приложением к промпту)", async () => {
    const sdk = realisticSdk();
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete(BASE);
    const req: LlmRequest = {
      ...BASE,
      messages: [
        ...BASE.messages,
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "app_launch", input: { app: "notepad" } }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "скрин" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              ],
            },
          ],
        },
      ],
    };
    await p.complete(req);
    const delivered = sdk.handlerResults[0] as { content: Array<{ type: string; data?: string; mimeType?: string }> };
    expect(delivered.content[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
  });

  it("история разошлась с сессией (новая реплика владельца вместо результата) → старая сессия закрыта, новая query", async () => {
    const sdk = realisticSdk();
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete(BASE);
    const abort0 = sdk.queries[0]?.abort;
    await p.complete({ ...BASE, messages: [...BASE.messages, { role: "assistant", content: "ок" }, { role: "user", content: "а теперь калькулятор" }] });
    expect(sdk.queries).toHaveLength(2);
    expect(abort0?.signal.aborted).toBe(true); // висящий CLI не остаётся
    expect((sdk.handlerResults[0] as { isError?: boolean }).isError).toBe(true); // хендлер разбужен отменой, не висит
  });

  it("изменился набор инструментов (tool_load) → сессия не продолжается, новая query", async () => {
    const sdk = realisticSdk();
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete(BASE);
    await p.complete({ ...continued(), tools: [APP_LAUNCH, { name: "web_search", description: "поиск", input_schema: { type: "object", properties: {} } }] });
    expect(sdk.queries).toHaveLength(2);
  });

  it("release(taskId) закрывает сессию задачи: query прервана, повторный release безвреден", async () => {
    const sdk = realisticSdk();
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete(BASE);
    expect(p.liveSessions).toBe(1);
    p.release("task-1");
    p.release("task-1");
    expect(p.liveSessions).toBe(0);
    expect(sdk.queries[0]?.abort.signal.aborted).toBe(true);
    // Следующий раунд той же задачи после release — честно новая сессия, а не ошибка.
    await p.complete(continued());
    expect(sdk.queries).toHaveLength(2);
  });

  it("без sessionKey — разовый вызов: после tool_use query прерывается (инструмент исполняет петля, не SDK)", async () => {
    const sdk = realisticSdk();
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    const { sessionKey: _k, ...keyless } = BASE;
    const r = await p.complete(keyless);
    expect(r.stopReason).toBe("tool_use");
    expect(sdk.queries[0]?.options.maxTurns).toBe(1);
    expect(sdk.queries[0]?.abort.signal.aborted).toBe(true);
    expect(p.liveSessions).toBe(0);
    await sleep(5);
    expect((sdk.handlerResults[0] as { isError?: boolean }).isError).toBe(true); // хендлер не завис
  });

  it("с ключом сессии потолок ходов SDK снят (цикл ведёт наша петля), таймаут инструмента задан серверу MCP", async () => {
    const sdk = realisticSdk();
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete(BASE);
    expect(sdk.queries[0]?.options.maxTurns).toBeGreaterThan(1);
    const server = (sdk.queries[0]?.options.mcpServers as Record<string, { timeout?: number }>).jarvis as { timeout?: number };
    expect(server.timeout).toBeGreaterThanOrEqual(120_000); // skill.execute/code_run/wait_for — минуты
    const env = sdk.queries[0]?.options.env as Record<string, string>;
    expect(Number(env.MAX_MCP_OUTPUT_TOKENS)).toBeGreaterThan(25_000); // дефолтный кап CLI ниже нашего tool_result
    p.release("task-1");
  });

  it("ошибка канала ПОСЛЕ результата инструмента → исключение с причиной, сессия снята", async () => {
    const sdk = realisticSdk();
    sdk.failAfterTool = "You've hit your session limit · resets 2:20pm";
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete(BASE);
    await expect(p.complete(continued())).rejects.toThrow(/лимит подписки/);
    expect(p.liveSessions).toBe(0);
  });
});

describe("W2: continuationOutcomes (что считается продолжением)", () => {
  const pending = new Set(["t1"]);
  it("хвост = ровно результаты ожидаемых вызовов → продолжение", () => {
    expect(continuationOutcomes(continued(), pending)?.map((o) => o.toolUseId)).toEqual(["t1"]);
  });
  it("не хватает результата или лишний id → не продолжение", () => {
    expect(continuationOutcomes(continued(), new Set(["t1", "t2"]))).toBeUndefined();
    expect(continuationOutcomes(continued(), new Set(["t9"]))).toBeUndefined();
  });
  it("текстовая реплика владельца хвостом → не продолжение", () => {
    expect(continuationOutcomes({ ...BASE, messages: [...BASE.messages, { role: "user", content: "ещё раз" }] }, pending)).toBeUndefined();
  });
  it("картинка верхнего уровня в user-сообщении → не продолжение (её сессии не донести)", () => {
    const req = continued();
    (req.messages[req.messages.length - 1] as { content: unknown[] }).content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } });
    expect(continuationOutcomes(req, pending)).toBeUndefined();
  });
});

describe("W2: SubscriptionSession (мост хендлер ↔ результат)", () => {
  it("matchKey не зависит от порядка ключей аргументов", () => {
    expect(matchKey("a", { x: 1, y: { b: 2, a: 1 } })).toBe(matchKey("a", { y: { a: 1, b: 2 }, x: 1 }));
    expect(matchKey("a", { x: 1 })).not.toBe(matchKey("b", { x: 1 }));
  });

  it("toMcpResult: пустой результат не отдаётся пустым массивом, ошибка помечается", () => {
    expect(toMcpResult({ toolUseId: "t", content: [] }).content).toHaveLength(1);
    expect(toMcpResult({ toolUseId: "t", content: "x", isError: true }).isError).toBe(true);
    expect(toMcpResult({ toolUseId: "t", content: "x" }).isError).toBeUndefined();
  });

  it("два ОДИНАКОВЫХ вызова получают результаты в порядке поступления", async () => {
    let handlers: FakeTool[] = [];
    const query = ({ options }: { options: Record<string, unknown> }) =>
      (async function* () {
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "a", name: "mcp__jarvis__k", input: { args: { n: 1 } } },
              { type: "tool_use", id: "b", name: "mcp__jarvis__k", input: { args: { n: 1 } } },
            ],
          },
        };
        yield { type: "stream_event", event: { type: "message_stop" } };
        void options;
        await new Promise(() => {}); // сессию закроют снаружи
      })();
    const s = new SubscriptionSession(query as never, { fingerprint: "f", turnTimeoutMs: 60_000, idleTimeoutMs: 60_000 });
    void handlers;
    handlers = [];
    const first = await s.start("p", {});
    expect(first.toolUses.map((u) => u.id)).toEqual(["a", "b"]);
    const ra = s.handle("k", { n: 1 });
    const rb = s.handle("k", { n: 1 });
    void s.continueWith([
      { toolUseId: "a", content: "первый" },
      { toolUseId: "b", content: "второй" },
    ]);
    expect((await ra).content[0]).toEqual({ type: "text", text: "первый" });
    expect((await rb).content[0]).toEqual({ type: "text", text: "второй" });
    s.close("тест");
  });

  it("зависший ход модели завершается по таймауту ошибкой, а не висит вечно", async () => {
    vi.useFakeTimers();
    const query = () =>
      (async function* () {
        await new Promise(() => {});
        yield {};
      })();
    const s = new SubscriptionSession(query as never, { fingerprint: "f", turnTimeoutMs: 1000, idleTimeoutMs: 60_000 });
    const p = s.start("p", {});
    await vi.advanceTimersByTimeAsync(1001);
    const turn = await p;
    expect(turn.ended).toBe(true);
    expect(turn.errorText).toMatch(/не завершился/);
    expect(s.alive).toBe(false);
  });

  it("петля не вернула результат за idle-таймаут → сессия закрыта (CLI не висит часами)", async () => {
    vi.useFakeTimers();
    let onClose = "";
    const query = () =>
      (async function* () {
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "mcp__jarvis__k", input: {} }] } };
        yield { type: "stream_event", event: { type: "message_stop" } };
        await new Promise(() => {});
      })();
    const s = new SubscriptionSession(query as never, { fingerprint: "f", turnTimeoutMs: 60_000, idleTimeoutMs: 5000, onClose: (r) => (onClose = r) });
    await s.start("p", {});
    expect(s.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(5001);
    expect(s.alive).toBe(false);
    expect(onClose).toMatch(/не вернула/);
  });
});

describe("W2: устойчивость моста к схеме tool() SDK", () => {
  it("хендлер получил СРЕЗАННЫЕ аргументы (модель положила поля наверх, z.object их отсёк) → результат находится по имени, действие не повторяется", async () => {
    const sdk = realisticSdk();
    sdk.handlerDelayMs = 3000; // штатный вызов хендлера поддельным CLI откладываем — зовём его сами
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete(BASE);
    // Эмулируем CLI: хендлер вызван с пустыми args (поля отсечены валидацией), а не с {app:"notepad"}
    const tool = ((sdk.queries[0]?.options.mcpServers as Record<string, { tools: FakeTool[] }>).jarvis as { tools: FakeTool[] }).tools[0] as FakeTool;
    const early = tool.handler({});
    const second = p.complete(continued());
    const r = await early;
    expect(r.content[0]).toEqual({ type: "text", text: "ok, окно 42" }); // нашёлся по имени, не по аргументам
    p.release("task-1");
    await second.catch(() => undefined); // сессия закрыта нами — ход честно не состоялся
  });

  it("схема инструмента: args НЕОБЯЗАТЕЛЕН (обязательный отсекал бы хендлер и вёл к двойному действию)", async () => {
    const shapes: unknown[] = [];
    const sdk = { ...realisticSdk(), tool: (name: string, _d: string, shape: unknown, handler: FakeTool["handler"]) => (shapes.push(shape), { name, handler }) } as FakeSdk;
    await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete(BASE);
    const shape = shapes[0] as { args: { isOptional: () => boolean } };
    expect(shape.args.isOptional()).toBe(true);
  });
});

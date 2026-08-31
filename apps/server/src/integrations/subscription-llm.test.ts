// Волна G: резервный провайдер на подписке (Agent SDK) — маппинг нашего контракта на SDK.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionLlmProvider, type SdkModule, serializeHistory } from "./subscription-llm.js";
import type { LlmRequest } from "./llm.js";

const BASE: LlmRequest = {
  tier: "sonnet",
  model: "claude-sonnet-4-6",
  systemStatic: "ПЕРСОНА",
  systemDynamic: "КОНТЕКСТ",
  messages: [{ role: "user", content: "запусти блокнот" }],
};

/** Мок SDK: отдаёт заранее заданные сообщения потока. */
function fakeSdk(messages: Array<Record<string, unknown>>): SdkModule & { lastOptions?: Record<string, unknown>; lastPrompt?: string } {
  const sdk: SdkModule & { lastOptions?: Record<string, unknown>; lastPrompt?: string } = {
    query({ prompt, options }) {
      sdk.lastPrompt = prompt;
      sdk.lastOptions = options;
      return (async function* () {
        for (const m of messages) yield m;
      })();
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (opts) => ({ type: "sdk", name: opts.name, tools: opts.tools }),
  };
  return sdk;
}

const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
afterEach(() => {
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
  delete process.env.JARVIS_SUBSCRIPTION_FALLBACK;
});

describe("SubscriptionLlmProvider.live (честность доступности)", () => {
  it("без токена подписки — НЕ live, причина названа", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(new SubscriptionLlmProvider().live).toBe(false);
    expect(SubscriptionLlmProvider.unavailableReason()).toContain("setup-token");
  });

  it("с токеном — live", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    expect(new SubscriptionLlmProvider().live).toBe(true);
    expect(SubscriptionLlmProvider.unavailableReason()).toBeUndefined();
  });

  it("выключатель JARVIS_SUBSCRIPTION_FALLBACK=0 гасит резерв даже с токеном", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    process.env.JARVIS_SUBSCRIPTION_FALLBACK = "0";
    expect(new SubscriptionLlmProvider().live).toBe(false);
    expect(SubscriptionLlmProvider.unavailableReason()).toContain("выключен");
  });
});

describe("SubscriptionLlmProvider.complete (маппинг SDK)", () => {
  it("текстовый ход: собирает текст, usage и end_turn", async () => {
    const sdk = fakeSdk([
      { type: "assistant", message: { content: [{ type: "text", text: "Блокнот открыт." }] } },
      { type: "result", subtype: "success", usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 3 } },
    ]);
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    const r = await p.complete(BASE);
    expect(r.text).toBe("Блокнот открыт.");
    expect(r.stopReason).toBe("end_turn");
    expect(r.stubbed).toBe(false); // это НАСТОЯЩИЙ ход, а не заглушка
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 3, cacheCreationTokens: 0 });
  });

  it("tool_use перехватывается и отдаётся НАМ (исполняет agent-loop, не SDK)", async () => {
    const sdk = fakeSdk([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "mcp__jarvis__app_launch", input: { args: { app: "notepad" } } }] },
      },
      { type: "result", subtype: "success", usage: {} },
    ]);
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    const r = await p.complete({ ...BASE, tools: [{ name: "app_launch", description: "запуск", input_schema: { type: "object", properties: {} } }] });
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses[0]?.name).toBe("app_launch"); // MCP-префикс срезан
    expect(r.toolUses[0]?.input).toEqual({ app: "notepad" }); // распакован из args
  });

  it("ошибка SDK (истёкший токен/лимит подписки) → исключение, а не пустой «успех»", async () => {
    const sdk = fakeSdk([{ type: "result", subtype: "error_during_execution", result: "OAuth session expired" }]);
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await expect(p.complete(BASE)).rejects.toThrow(/OAuth session expired/);
  });

  it("ANTHROPIC_API_KEY вычищается из env подпроцесса (иначе SDK уйдёт на платный API)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
    await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete(BASE);
    const env = sdk.lastOptions?.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("встроенные инструменты Claude Code отключены, свои — отданы под allowedTools", async () => {
    const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
    await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete({
      ...BASE,
      tools: [{ name: "app_launch", description: "d", input_schema: { type: "object", properties: {} } }],
    });
    expect(sdk.lastOptions?.tools).toEqual([]); // никакого Bash/Read от Claude Code
    expect(sdk.lastOptions?.allowedTools).toEqual(["mcp__jarvis__*"]);
    expect(sdk.lastOptions?.maxTurns).toBe(1); // цикл ведём МЫ
  });

  it("стрим отдаёт дельты и сохраняет инвариант «сумма дельт === text»", async () => {
    const sdk = fakeSdk([
      { type: "stream_event", event: { delta: { type: "text_delta", text: "При" } } },
      { type: "stream_event", event: { delta: { type: "text_delta", text: "вет." } } },
      { type: "result", subtype: "success", usage: {} },
    ]);
    const deltas: string[] = [];
    const r = await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).completeStream(BASE, (d) => deltas.push(d.text));
    expect(deltas.join("")).toBe("Привет.");
    expect(r.text).toBe("Привет.");
  });

  it("тир fable → opus, прочее → sonnet", async () => {
    const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete({ ...BASE, tier: "fable", model: "claude-opus-4-8" });
    expect(sdk.lastOptions?.model).toBe("opus");
    await p.complete(BASE);
    expect(sdk.lastOptions?.model).toBe("sonnet");
  });
});

describe("serializeHistory (история → текстовый транскрипт)", () => {
  it("размечает роли, вызовы и результаты — модель не путает свои ходы с речью владельца", () => {
    const s = serializeHistory({
      ...BASE,
      messages: [
        { role: "user", content: "открой блокнот" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "app_launch", input: { app: "notepad" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "запущен" }] },
      ],
    });
    expect(s).toContain("### ВЛАДЕЛЕЦ/СИСТЕМА\nоткрой блокнот");
    expect(s).toContain("### ТЫ ВЫЗВАЛ ИНСТРУМЕНТ\napp_launch");
    expect(s).toContain("### РЕЗУЛЬТАТ ИНСТРУМЕНТА\nзапущен");
  });

  it("ошибка инструмента помечена, картинки честно названы непереданными", () => {
    const s = serializeHistory({
      ...BASE,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "не вышло", is_error: true }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }] },
      ],
    });
    expect(s).toContain("[ОШИБКА]");
    expect(s).toContain("в резервном режиме не передаётся");
  });
});

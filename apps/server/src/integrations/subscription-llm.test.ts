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
function fakeSdk(
  messages: Array<Record<string, unknown>>,
): SdkModule & { lastOptions?: Record<string, unknown>; lastPrompt?: string | AsyncIterable<Record<string, unknown>> } {
  const sdk: SdkModule & { lastOptions?: Record<string, unknown>; lastPrompt?: string | AsyncIterable<Record<string, unknown>> } = {
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
  it("с токеном — live и режим авторизации «token»", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    expect(new SubscriptionLlmProvider().live).toBe(true);
    expect(SubscriptionLlmProvider.authMode()).toBe("token");
    expect(SubscriptionLlmProvider.unavailableReason()).toBeUndefined();
  });

  it("без токена — авторизация по сохранённому логину, если он есть; иначе честная причина с ОБЕИМИ командами", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const mode = SubscriptionLlmProvider.authMode();
    if (mode === "stored-login") {
      // На машине владельца файл логина есть — резерв ПРОБУЕТ его (при отказе честно деградирует).
      expect(new SubscriptionLlmProvider().live).toBe(true);
      expect(SubscriptionLlmProvider.unavailableReason()).toBeUndefined();
    } else {
      expect(new SubscriptionLlmProvider().live).toBe(false);
      const why = SubscriptionLlmProvider.unavailableReason() ?? "";
      expect(why).toContain("setup-token");
      expect(why).toContain("/login");
    }
  });

  it("выключатель JARVIS_SUBSCRIPTION_FALLBACK=0 гасит резерв даже с токеном", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    process.env.JARVIS_SUBSCRIPTION_FALLBACK = "0";
    expect(new SubscriptionLlmProvider().live).toBe(false);
    expect(SubscriptionLlmProvider.unavailableReason()).toContain("выключен");
  });

  it("токен НЕ подсовывается пустым в env подпроцесса (иначе перебил бы сохранённый логин)", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
    await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete(BASE);
    const env = sdk.lastOptions?.env as Record<string, string | undefined>;
    expect("CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(false);
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

  // 🔴 Зрение в резерве: без передачи картинок Джарвис на подписке слеп, а «сверь глазами» —
  // основа его честности на GUI-задачах.
  it("картинки истории доносятся до модели блоками (streaming input), а не теряются", async () => {
    const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
    const png = { type: "base64" as const, media_type: "image/png", data: "AAAA" };
    await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete({
      ...BASE,
      messages: [
        { role: "user", content: "посмотри на экран" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: png }] }] },
      ],
    });
    expect(typeof sdk.lastPrompt).not.toBe("string"); // ушли в режим блоков
    const msgs: Array<Record<string, unknown>> = [];
    for await (const m of sdk.lastPrompt as AsyncIterable<Record<string, unknown>>) msgs.push(m);
    const content = (msgs[0]?.message as { content?: Array<Record<string, unknown>> })?.content ?? [];
    expect(content.some((b) => b.type === "image")).toBe(true);
    expect(content.some((b) => b.type === "text")).toBe(true);
  });

  it("без картинок промпт остаётся простой строкой (не усложняем обычный путь)", async () => {
    const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
    await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete(BASE);
    expect(typeof sdk.lastPrompt).toBe("string");
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

  // §7/§2.7: резерв обязан уважать нашу пер-раундовую политику размышления, а не дефолт SDK.
  it("на МАКС эффорте размышление не глушим даже при политике «off» (max без thinking — противоречие)", async () => {
    const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete({ ...BASE, thinking: "off" }); // дефолтный эффорт = max
    expect(sdk.lastOptions?.thinking).toEqual({ type: "adaptive" });
    await p.complete({ ...BASE, thinking: "adaptive" });
    expect(sdk.lastOptions?.thinking).toEqual({ type: "adaptive" });
    await p.complete({ ...BASE, thinking: 4096 }); // числовой бюджет 400-ит на свежих семействах
    expect(sdk.lastOptions?.thinking).toEqual({ type: "adaptive" });
  });

  it("на невысоком эффорте пер-раундовая политика §2.7 уважается: off → disabled", async () => {
    process.env.JARVIS_SUBSCRIPTION_EFFORT = "high";
    try {
      const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
      await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete({ ...BASE, thinking: "off" });
      expect(sdk.lastOptions?.thinking).toEqual({ type: "disabled" });
    } finally {
      delete process.env.JARVIS_SUBSCRIPTION_EFFORT;
    }
  });

  it("потолок вывода уходит в env подпроцесса (per-call параметра у SDK нет)", async () => {
    const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
    await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete({ ...BASE, maxTokens: 1500 });
    const env = sdk.lastOptions?.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("1500");
  });

  // Решение владельца: резерв — на СИЛЬНОЙ модели и МАКСИМАЛЬНОМ эффорте (последний шанс сделать
  // ход правильно; лимиты подписки уже оплачены). Живым зондом подтверждено: fable/opus доступны.
  it("по умолчанию модель fable и эффорт max — независимо от тира хода", async () => {
    const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete({ ...BASE, tier: "haiku" });
    expect(sdk.lastOptions?.model).toBe("fable");
    expect(sdk.lastOptions?.effort).toBe("max");
  });

  it("модель и эффорт переопределяются env", async () => {
    process.env.JARVIS_SUBSCRIPTION_MODEL = "claude-opus-5";
    process.env.JARVIS_SUBSCRIPTION_EFFORT = "high";
    try {
      const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
      await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete(BASE);
      expect(sdk.lastOptions?.model).toBe("claude-opus-5");
      expect(sdk.lastOptions?.effort).toBe("high");
    } finally {
      delete process.env.JARVIS_SUBSCRIPTION_MODEL;
      delete process.env.JARVIS_SUBSCRIPTION_EFFORT;
    }
  });

  it("мусорный эффорт из env → безопасный max, а не передача мусора в SDK", async () => {
    process.env.JARVIS_SUBSCRIPTION_EFFORT = "ультра";
    try {
      const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
      await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete(BASE);
      expect(sdk.lastOptions?.effort).toBe("max");
    } finally {
      delete process.env.JARVIS_SUBSCRIPTION_EFFORT;
    }
  });

  // 🔴 Живой зонд: при maxTurns:1 SDK помечает штатное «модель запросила инструмент» как
  // error_max_turns — считать это ошибкой значило бы превращать честный ход в стаб.
  it("error_max_turns с пойманным вызовом инструмента — НЕ ошибка", async () => {
    const sdk = fakeSdk([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__jarvis__app_launch", input: { args: { app: "x" } } }] } },
      { type: "result", subtype: "error_max_turns", result: "Reached maximum number of turns (1)" },
    ]);
    const r = await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete(BASE);
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolUses[0]?.name).toBe("app_launch");
  });

  it("настоящая ошибка БЕЗ результата — по-прежнему исключение (стаб, а не пустой успех)", async () => {
    const sdk = fakeSdk([{ type: "result", subtype: "error_during_execution", result: "OAuth session expired" }]);
    await expect(new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete(BASE)).rejects.toThrow(/OAuth/);
  });

  it("слишком длинное имя инструмента не отдаётся в резерв (лимит 64 с префиксом)", async () => {
    const sdk = fakeSdk([{ type: "result", subtype: "success", usage: {} }]);
    const longName = `mcp__server__${"x".repeat(60)}`;
    await new SubscriptionLlmProvider({ loadSdk: async () => sdk }).complete({
      ...BASE,
      tools: [
        { name: "app_launch", description: "d", input_schema: { type: "object", properties: {} } },
        { name: longName, description: "d", input_schema: { type: "object", properties: {} } },
      ],
    });
    const server = (sdk.lastOptions?.mcpServers as { jarvis?: { tools?: unknown[] } })?.jarvis;
    expect(server?.tools).toHaveLength(1); // длинный отфильтрован, короткий остался
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
    expect(s).toContain("приложен отдельным блоком"); // картинка не теряется, а идёт блоком
  });
});

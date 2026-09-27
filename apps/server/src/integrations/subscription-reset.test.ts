/**
 * W3 (L-6, L-13): НАСТОЯЩИЙ SubscriptionLlmProvider против поддельного SDK «как настоящий» (scripted-sdk.ts).
 *  - L-6: петля переписала историю (`historyRewritten`) → живая сессия CLI её не видит → провайдер начинает новую
 *    со свёрнутым транскриптом; без флага — продолжение той же сессии; «pruned» — только за порогом картинок;
 *  - L-13: настоящие `tool`/`createSdkMcpServer` из @anthropic-ai/claude-agent-sdk (поддельна только `query`): каждый
 *    наш инструмент виден по MCP с `_meta['anthropic/alwaysLoad']` — поиск инструментов CLI его не отложит.
 * Реверт-проверки (из копии): игнорировать флаг в rewriteResetReason — падают кейсы сброса; «pruned» без порога —
 * падает кейс порога; убрать `alwaysLoad: true` из createSdkMcpServer — падает кейс L-13.
 */
import { describe, expect, it } from "vitest";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SubscriptionLlmProvider, type SdkModule } from "./subscription-llm.js";
import { PRUNE_RESET_IMAGES } from "./subscription-continuity.js";
import type { LlmContentBlock, LlmMessage, LlmRequest, ToolResultContent } from "./llm.js";
import { scriptedSdk } from "./test-support/scripted-sdk.js";

const WEB_FETCH = { name: "web_fetch", description: "страница", input_schema: { type: "object", properties: { url: { type: "string" } } } };
const SHOT = { name: "screen_capture", description: "снимок", input_schema: { type: "object", properties: {} } };
const STUB = "[наблюдение свёрнуто ради места в контексте: web_fetch, было ~30000 симв.]";
const IMG: ToolResultContent = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };

function base(tools = [WEB_FETCH]): LlmRequest {
  return { tier: "sonnet", model: "m", systemStatic: "ПЕРСОНА", messages: [{ role: "user", content: "сведи три страницы" }], tools, sessionKey: "task-1" };
}

/** История после хода: + assistant(tool_use) + user(tool_result). Возвращает новый массив (как петля — дописывает). */
function withResult(messages: LlmMessage[], id: string, name: string, input: Record<string, unknown>, content: string | ToolResultContent[]): LlmMessage[] {
  const use: LlmContentBlock = { type: "tool_use", id, name, input };
  const res: LlmContentBlock = { type: "tool_result", tool_use_id: id, content };
  return [...messages, { role: "assistant", content: [use] }, { role: "user", content: [res] }];
}

const fetchStep = (url: string) => ({ tool: { name: "web_fetch", args: { url } } });

describe("W3 L-6: провайдер подписки и переписанная петлёй история", () => {
  it("masked → новая сессия со СВЁРНУТЫМ транскриптом; прежняя закрыта, её инструмент второй раз не исполняется", async () => {
    const sdk = scriptedSdk([fetchStep("a"), fetchStep("b"), fetchStep("c"), { text: "Сводка готова." }]);
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    const r0 = await p.complete(base());
    let msgs = withResult(base().messages, r0.toolUses[0]!.id, "web_fetch", { url: "a" }, "СТРАНИЦА-А ".repeat(3000));
    const r1 = await p.complete({ ...base(), messages: msgs });
    expect(sdk.queries).toHaveLength(1); // обычное продолжение
    // петля свернула результат «a» (он в уже отправленной истории) и досылает результат «b»
    msgs = withResult(msgs, r1.toolUses[0]!.id, "web_fetch", { url: "b" }, "СТРАНИЦА-Б");
    const first = msgs[2] as { content: Array<{ content: unknown }> };
    first.content[0]!.content = STUB;
    const r2 = await p.complete({ ...base(), messages: msgs, historyRewritten: "masked" });
    expect(sdk.queries).toHaveLength(2); // 🔴 суть L-6: свёрнутую историю несёт НОВАЯ сессия
    const fresh = sdk.queries[1]!;
    expect(fresh.promptText).toContain("наблюдение свёрнуто");
    expect(fresh.promptText).not.toContain("СТРАНИЦА-А");
    expect(fresh.promptText).toContain("СТРАНИЦА-Б");
    expect(r2.toolUses[0]?.input).toEqual({ url: "c" }); // модель продолжила сценарий, а не начала заново
    expect(sdk.queries[0]!.results).toHaveLength(1); // результат «b» в старую сессию не ушёл (она закрыта)
    expect(fresh.inputTokens[0]).toBeLessThan(sdk.queries[0]!.inputTokens[1]!); // реальный промпт стал меньше
  });

  it("без флага — одна сессия: результат уходит в ждущий хендлер, CLI не пересоздаётся", async () => {
    const sdk = scriptedSdk([fetchStep("a"), { text: "Готово." }]);
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    const r0 = await p.complete(base());
    const r1 = await p.complete({ ...base(), messages: withResult(base().messages, r0.toolUses[0]!.id, "web_fetch", { url: "a" }, "текст") });
    expect(r1.text).toBe("Готово.");
    expect(sdk.queries).toHaveLength(1);
    expect(sdk.queries[0]!.results[0]?.content[0]?.text).toBe("текст");
  });

  it(`pruned: до ${PRUNE_RESET_IMAGES} картинок в сессии — продолжаем; сверх порога — новая сессия с актуальными кадрами`, async () => {
    const steps = Array.from({ length: PRUNE_RESET_IMAGES + 3 }, () => ({ tool: { name: "screen_capture", args: {} } }));
    const sdk = scriptedSdk(steps);
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    let msgs = base([SHOT]).messages;
    let r = await p.complete({ ...base([SHOT]), messages: msgs });
    for (let n = 1; n <= PRUNE_RESET_IMAGES; n += 1) {
      msgs = withResult(msgs, r.toolUses[0]!.id, "screen_capture", {}, [IMG]);
      // петля вырезает устаревшие кадры каждый GUI-раунд — пока в сессии ≤ порога, это не повод к новому CLI
      r = await p.complete({ ...base([SHOT]), messages: msgs, historyRewritten: n > 1 ? "pruned" : undefined });
    }
    expect(sdk.queries).toHaveLength(1);
    expect(sdk.queries[0]!.results).toHaveLength(PRUNE_RESET_IMAGES);
    msgs = withResult(msgs, r.toolUses[0]!.id, "screen_capture", {}, [IMG]);
    await p.complete({ ...base([SHOT]), messages: msgs, historyRewritten: "pruned" });
    expect(sdk.queries).toHaveLength(2); // за порогом — новая сессия
    expect(sdk.queries[1]!.images).toBeLessThanOrEqual(2); // с собой — только свежие кадры
  });
});

describe("W3 L-13: alwaysLoad у MCP-сервера подписки (настоящий SDK-сервер)", () => {
  it("каждый наш инструмент в tools/list помечен _meta['anthropic/alwaysLoad']", async () => {
    const real = { tool: tool as unknown as SdkModule["tool"], createSdkMcpServer: createSdkMcpServer as unknown as SdkModule["createSdkMcpServer"] };
    const sdk = scriptedSdk([{ text: "Привет." }], real);
    const p = new SubscriptionLlmProvider({ loadSdk: async () => sdk });
    await p.complete({ ...base([WEB_FETCH, SHOT]), sessionKey: undefined });
    const server = (sdk.queries[0]!.options.mcpServers as Record<string, { instance: { connect: (t: unknown) => Promise<void> } }>).jarvis!;
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverT);
    const client = new Client({ name: "probe", version: "1.0.0" });
    await client.connect(clientT);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["screen_capture", "web_fetch"]);
    for (const t of tools) expect(t._meta?.["anthropic/alwaysLoad"]).toBe(true);
    await client.close();
  });
});

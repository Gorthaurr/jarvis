/**
 * W3 (L-6): поддельный Agent SDK «как настоящий CLI» для тестов провайдера подписки и петли поверх него.
 *  - модель — СЦЕНАРИЙ шагов, общий на все query(): новая сессия продолжает с того шага, где остановилась прежняя
 *    (как настоящая модель, прочитавшая транскрипт);
 *  - tool_use → хендлер нашего MCP-сервера → ждём результат петли → следующий шаг в ТОЙ ЖЕ query;
 *  - usage каждого ответа ∝ истории ЭТОЙ сессии (промпт + все результаты, отданные хендлерам): живая сессия CLI
 *    помнит всё, что в неё ушло, и свёртка истории петлёй её не уменьшает — ровно дефект L-6.
 * Реальные `tool`/`createSdkMcpServer` подставляются снаружи (L-13); по умолчанию — лёгкие двойники.
 */
import type { SdkModule } from "../subscription-llm.js";

export interface ScriptStep {
  tool?: { name: string; args: Record<string, unknown> };
  text?: string;
}

type McpContent = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
type FakeTool = { name: string; handler: (args: unknown) => Promise<{ content: McpContent; isError?: boolean }> };

export interface QueryRecord {
  prompt: unknown;
  /** Текст промпта (транскрипт) — строкой или первым text-блоком streaming-input. */
  promptText: string;
  images: number;
  options: Record<string, unknown>;
  /** Что вернули хендлеры инструментов в этой сессии (MCP-результаты). */
  results: Array<{ content: McpContent; isError?: boolean }>;
  /** Вход (токены) каждого ответа этой сессии — как его увидит гард контекста петли. */
  inputTokens: number[];
}

export interface ScriptedSdk extends SdkModule {
  queries: QueryRecord[];
  /** Сколько шагов сценария уже отдано. */
  cursor(): number;
}

const CHARS_PER_TOKEN = 2.5;
const mcpChars = (c: McpContent): number => c.reduce((n, b) => n + (b.text?.length ?? 0) + (b.type === "image" ? 4000 : 0), 0);

async function readPrompt(prompt: unknown): Promise<{ text: string; images: number }> {
  if (typeof prompt === "string") return { text: prompt, images: 0 };
  let text = "";
  let images = 0;
  for await (const m of prompt as AsyncIterable<{ message?: { content?: Array<{ type: string; text?: string }> } }>) {
    for (const b of m.message?.content ?? []) {
      if (b.type === "text") text += b.text ?? "";
      if (b.type === "image") images += 1;
    }
  }
  return { text, images };
}

export function scriptedSdk(steps: ScriptStep[], real?: Pick<SdkModule, "tool" | "createSdkMcpServer">): ScriptedSdk {
  let cursor = 0;
  const sdk: ScriptedSdk = {
    queries: [],
    cursor: () => cursor,
    tool: real?.tool ?? ((name, _d, _s, handler) => ({ name, handler }) as FakeTool),
    createSdkMcpServer: real?.createSdkMcpServer ?? ((opts) => ({ type: "sdk", name: opts.name, tools: opts.tools, alwaysLoad: opts.alwaysLoad })),
    query({ prompt, options }) {
      const abort = options.abortController as AbortController;
      const rec: QueryRecord = { prompt, promptText: "", images: 0, options, results: [], inputTokens: [] };
      sdk.queries.push(rec);
      const tools = ((options.mcpServers as Record<string, { tools?: FakeTool[] }> | undefined)?.jarvis?.tools ?? []) as FakeTool[];
      return (async function* () {
        const p = await readPrompt(prompt);
        rec.promptText = p.text;
        rec.images = p.images;
        let historyChars = p.text.length + p.images * 4000;
        yield { type: "system", subtype: "init" };
        for (;;) {
          const i = cursor;
          const step = steps[i] ?? { text: "Готово." };
          cursor += 1;
          const input = Math.ceil(historyChars / CHARS_PER_TOKEN);
          rec.inputTokens.push(input);
          const usage = { input_tokens: input, output_tokens: 20 };
          if (step.tool) {
            const id = `t${i}`;
            yield { type: "assistant", message: { id: `m${i}`, usage, content: [{ type: "tool_use", id, name: `mcp__jarvis__${step.tool.name}`, input: { args: step.tool.args } }] } };
            yield { type: "stream_event", event: { type: "message_stop" } };
            const t = tools.find((x) => x.name === step.tool?.name);
            if (!t) return;
            const r = await t.handler({ args: step.tool.args });
            if (abort.signal.aborted) return;
            rec.results.push(r);
            historyChars += mcpChars(r.content);
            continue;
          }
          const text = step.text ?? "";
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } };
          yield { type: "assistant", message: { id: `m${i}`, usage, content: [{ type: "text", text }] } };
          yield { type: "result", subtype: "success", usage: {} };
          return;
        }
      })();
    },
  };
  return sdk;
}

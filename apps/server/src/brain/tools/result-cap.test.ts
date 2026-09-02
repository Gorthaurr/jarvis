/**
 * Серверный кап текста tool_result (причина №6 USER_SCENARIOS_2026-09-02): fs_read на мегабайты / MCP-ответ не уходит
 * в промпт целиком — обрезается ВИДИМО (пометка с полной длиной и что делать), untrusted-обёртка остаётся целой,
 * маленькие результаты не трогаются. Через реальный dispatchTool.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { DEFAULT_TOOL_RESULT_MAX_CHARS, capResultBody, toolResultMaxChars } from "./dispatch-util.js";
import { dispatchTool, type ToolContext } from "./dispatch.js";

const saved = process.env.JARVIS_TOOL_RESULT_MAX_CHARS;
beforeAll(() => {
  process.env.JARVIS_TOOL_RESULT_MAX_CHARS = "5000";
});
afterAll(() => {
  if (saved === undefined) delete process.env.JARVIS_TOOL_RESULT_MAX_CHARS;
  else process.env.JARVIS_TOOL_RESULT_MAX_CHARS = saved;
});

function ctxWith(data: unknown): ToolContext {
  const sendAction = vi.fn(async (_cmd: ActionCommand): Promise<ActionResult> => ({ commandId: "c", ok: true, data, durationMs: 1 }));
  return { session: { sendAction }, userId: "u1" } as unknown as ToolContext;
}

describe("capResultBody (чистая)", () => {
  it("короткое тело — как есть; длинное — обрезано с пометкой о полной длине и подсказкой", () => {
    expect(capResultBody("abc")).toBe("abc");
    const big = "я".repeat(12_000);
    const out = capResultBody(big, "Читай окном.");
    expect(out.length).toBeLessThan(5_400);
    expect(out).toContain("ОБРЕЗАНО сервером: показано 5000 из 12000");
    expect(out).toContain("Читай окном.");
  });

  it("env ниже пола / мусор → дефолт", () => {
    process.env.JARVIS_TOOL_RESULT_MAX_CHARS = "10";
    expect(toolResultMaxChars()).toBe(DEFAULT_TOOL_RESULT_MAX_CHARS);
    process.env.JARVIS_TOOL_RESULT_MAX_CHARS = "5000";
    expect(toolResultMaxChars()).toBe(5000);
  });
});

describe("dispatchTool × кап", () => {
  it("fs_read на 20 000 символов → в tool_result не больше капа, пометка велит читать окном, обёртка untrusted закрыта", async () => {
    const r = await dispatchTool("fs_read", { path: "C:/big.log" }, ctxWith({ content: "x".repeat(20_000), bytes: 20_000, truncated: false }));
    const text = String(r.content);
    expect(r.isError).toBe(false);
    expect(text.length).toBeLessThan(6_500);
    expect(text).toContain("ОБРЕЗАНО сервером: показано 5000 из");
    expect(text).toContain("fs_read{offset,lines}");
    // Пометка — наш статус, а не данные: СНАРУЖИ обёртки (внутри она неотличима от текста файла-инъекции).
    expect(text.indexOf("ОБРЕЗАНО")).toBeGreaterThan(text.indexOf("</untrusted_content>"));
  });

  it("маленький fs_read — без пометки; fs_search подсказывает сузить запрос", async () => {
    const small = await dispatchTool("fs_read", { path: "C:/a.txt" }, ctxWith({ content: "привет", bytes: 12, truncated: false }));
    expect(String(small.content)).not.toContain("ОБРЕЗАНО");
    const big = await dispatchTool("fs_search", { root: "C:/", query: "x" }, ctxWith({ matches: Array.from({ length: 400 }, (_, i) => ({ path: `C:/dir/${"f".repeat(40)}${i}.txt` })) }));
    expect(String(big.content)).toContain("Сузь root/query");
  });

  it("MCP-ответ тоже капается (ветка untrusted mcp:*)", async () => {
    const mcp = {
      connected: true,
      has: (n: string) => n === "mcp__srv__dump",
      requiresConfirm: () => false,
      callTool: vi.fn(async () => ({ content: "y".repeat(30_000), isError: false })),
    };
    const ctx = { session: { sendAction: vi.fn() }, userId: "u1", mcp } as unknown as ToolContext;
    const r = await dispatchTool("mcp__srv__dump", { q: "all" }, ctx);
    const text = String(r.content);
    expect(text).toContain("ОБРЕЗАНО сервером: показано 5000 из 30000");
    expect(text.length).toBeLessThan(6_500);
  });
});

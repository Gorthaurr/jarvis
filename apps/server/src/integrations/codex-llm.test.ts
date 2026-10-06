import { describe, expect, it, vi } from "vitest";
import { CodexLlmProvider } from "./codex-llm.js";
import { TestCodexTransport } from "./codex/test-transport.js";
import type { LlmRequest } from "./llm.js";
import { codexInput } from "./codex/messages.js";

const request: LlmRequest = { model: "claude", tier: "sonnet", systemStatic: "Jarvis", sessionKey: "task",
  messages: [{ role: "user", content: "Прочитай" }], tools: [{ name: "read", description: "read", input_schema: { type: "object" } }] };
async function setup() {
  const rpc = new TestCodexTransport(); const provider = new CodexLlmProvider(() => rpc, "test-model");
  const promise = provider.complete(request);
  await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledWith("turn/start", expect.anything()));
  return { rpc, provider, promise };
}
describe("Codex ChatGPT bridge", () => {
  it("сохраняет одну сессию и передаёт результаты нескольких инструментов обратно модели", async () => {
    const { rpc, provider, promise } = await setup();
    rpc.tool(1); rpc.tool(2);
    const first = await promise;
    expect(first.toolUses.map((t) => t.id)).toEqual(["call-1", "call-2"]);
    const next = provider.complete({ ...request, messages: [...request.messages, { role: "user", content: [
      { type: "tool_result", tool_use_id: "call-1", content: "41" },
      { type: "tool_result", tool_use_id: "call-2", content: "42" },
    ] }] });
    await vi.waitFor(() => expect(rpc.respond).toHaveBeenCalledTimes(2));
    expect(rpc.respond.mock.calls[0]).toEqual([1, { success: true, contentItems: [{ type: "inputText", text: "41" }] }]);
    rpc.done("41 и 42.");
    expect((await next).text).toBe("41 и 42.");
    expect(rpc.threads).toBe(1); provider.dispose();
  });
  it("EOF и release отклоняют ожидающий запрос", async () => {
    const a = await setup(); const failed = expect(a.promise).rejects.toThrow("transport lost"); a.rpc.fail(); await failed; a.provider.dispose();
    const b = await setup(); const cancelled = expect(b.promise).rejects.toThrow("отменена"); b.provider.release("task"); await cancelled; b.provider.dispose();
  });
  it("не принимает API-auth и не начинает генерацию", async () => {
    const rpc = new TestCodexTransport(); rpc.accountType = "apiKey";
    const p = new CodexLlmProvider(() => rpc, "test-model");
    await expect(p.complete(request)).rejects.toThrow("API-ключ запрещён");
    expect(rpc.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false); p.dispose();
  });
  it("пересоздаёт переписанную историю", async () => {
    const { rpc, provider, promise } = await setup(); rpc.tool(1); rpc.tool(2); await promise;
    const next = provider.complete({ ...request, historyRewritten: "masked" });
    await vi.waitFor(() => expect(rpc.threads).toBe(2)); rpc.done(); await next;
    expect(rpc.respond.mock.calls.every((call) => call[1].success === false)).toBe(true); provider.dispose();
  });
  it("отмена во время запуска не оставляет новую задачу после initialize", async () => {
    const rpc = new TestCodexTransport(); let ready!: (v: unknown) => void;
    rpc.request.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    const provider = new CodexLlmProvider(() => rpc, "test-model");
    const promise = provider.complete(request); provider.release("task"); ready({});
    await expect(promise).rejects.toThrow("отменена"); expect(rpc.threads).toBe(0); provider.dispose();
  });
  it("повторенный id результата не засчитывается за второй инструмент", async () => {
    const { rpc, provider, promise } = await setup(); rpc.tool(1); rpc.tool(2); await promise;
    const next = provider.complete({ ...request, messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "call-1", content: "42" },
      { type: "tool_result", tool_use_id: "call-1", content: "42" },
    ] }] });
    await vi.waitFor(() => expect(rpc.threads).toBe(2));
    expect(rpc.respond.mock.calls.every((call) => call[1].success === false)).toBe(true);
    rpc.done(); await next; provider.dispose();
  });
  it("ошибка отменяет поздний вызов старого батча и требует нового решения модели", async () => {
    const { rpc, provider, promise } = await setup(); rpc.tool(1); await promise;
    rpc.tool(2); // Пришёл после выдачи первого вызова петле: это всё ещё старое решение Codex.
    const next = provider.complete({ ...request, messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "call-1", content: "Ввод отклонён", is_error: true },
    ] }] });
    await vi.waitFor(() => expect(rpc.threads).toBe(2));
    expect(rpc.respond).toHaveBeenCalledWith(2, expect.objectContaining({ success: false }));
    const starts = rpc.request.mock.calls.filter(([method]) => method === "turn/start");
    expect(JSON.stringify(starts.at(-1))).toContain("Ввод отклонён");
    rpc.done("Действие не выполнено."); expect((await next).toolUses).toEqual([]); provider.dispose();
  });
  it("отделяет последнее окно контекста от нескольких задержанных обновлений расхода", async () => {
    const { rpc, provider, promise } = await setup(); rpc.tool(1); await promise;
    const next = provider.complete({ ...request, messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "call-1", content: "42" },
    ] }] });
    await vi.waitFor(() => expect(rpc.respond).toHaveBeenCalledTimes(1));
    for (const total of [100_000, 200_000]) rpc.event("thread/tokenUsage/updated", { tokenUsage: {
      total: { inputTokens: total, outputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0 }, last: { inputTokens: 100_000 },
    } });
    rpc.done(); const response = await next;
    expect(response.usage.inputTokens).toBe(200_000); expect(response.contextTokens).toBe(100_000); provider.dispose();
  });
  it("изображения остаются в multimodal input, ошибки — в транскрипте", () => {
    const input = codexInput({ ...request, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t",
      is_error: true, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] }] });
    expect(input[0]!.text).toContain('"is_error":true');
    expect(input[1]).toEqual({ type: "image", url: "data:image/png;base64,AAAA" });
  });
});

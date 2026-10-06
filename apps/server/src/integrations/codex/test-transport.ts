/** Детерминированный App Server для проверки границы с настоящей петлёй Jarvis. */
import { vi } from "vitest";
import type { CodexTransport, RpcMessage } from "./rpc.js";

export class TestCodexTransport implements CodexTransport {
  listeners = new Set<{ event: (e: RpcMessage) => void; failed: (e: Error) => void }>();
  threads = 0;
  accountType = "chatgpt";
  request = vi.fn(async (method: string, _params: any): Promise<any> => {
    if (method === "account/read") return { account: { type: this.accountType } };
    if (method === "model/list") return { data: [{ model: "test-model" }] };
    if (method === "thread/start") return { thread: { id: `thread-${++this.threads}` }, model: "test-model" };
    return {};
  });
  notify = vi.fn();
  respond = vi.fn();
  dispose = vi.fn();
  subscribe(event: (e: RpcMessage) => void, failed: (e: Error) => void) {
    const entry = { event, failed }; this.listeners.add(entry); return () => this.listeners.delete(entry);
  }
  event(method: string, params: any, id?: number) {
    for (const listener of this.listeners) listener.event({ method, id, params: { threadId: `thread-${this.threads}`, ...params } });
  }
  fail() { for (const listener of this.listeners) listener.failed(new Error("transport lost")); }
  tool(id: number, name = "read") {
    this.event("item/tool/call", { callId: `call-${id}`, tool: `jarvis__${name}`, arguments: {} }, id);
  }
  done(text = "Готово.") {
    this.event("item/completed", { item: { type: "agentMessage", text } });
    this.event("turn/completed", { turn: { status: "completed" } });
  }
}

/** При tool-call отдаём управление петле Jarvis, затем возвращаем фактический результат Codex. */
import type { LlmRequest, LlmResponse, ToolUse } from "../llm.js";
import { codexContent } from "./messages.js";
import type { CodexTransport, RpcMessage } from "./rpc.js";

interface Call { rpcId: string | number; tool: ToolUse }
const zero = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
export class CodexSession {
  turnId?: string;
  private calls: Call[] = [];
  private delivered = new Map<string, Call>();
  private text = "";
  private done = false;
  private error?: Error;
  private total = zero();
  private reported = zero();
  private contextTokens?: number;
  private waiter?: { resolve: (v: LlmResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private unsubscribe: () => void;
  constructor(private rpc: CodexTransport, readonly threadId: string, readonly model: string,
    readonly fingerprint: string, private names: Map<string, string>, private timeoutMs = 120_000) {
    this.unsubscribe = rpc.subscribe((v) => this.receive(v), (e) => { this.error = e; this.flush(); });
  }
  resume(req: LlmRequest): boolean {
    const last = req.messages.at(-1);
    if (!last || last.role !== "user" || typeof last.content === "string" || !this.delivered.size) return false;
    const results = last.content.filter((b) => b.type === "tool_result");
    // Поздний вызов может относиться к тому же батчу, который Jarvis уже остановил.
    // После любой ошибки перепланируем в новом thread с фактической историей, не выпускаем старую очередь.
    if (results.some((r) => r.is_error)) return false;
    const ids = new Set(results.map((r) => r.tool_use_id));
    if (results.length !== this.delivered.size || ids.size !== results.length || [...ids].some((id) => !this.delivered.has(id))) return false;
    const notes = last.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    for (const [index, result] of results.entries()) {
      const contentItems = codexContent(result.content);
      if (index === results.length - 1 && (notes || req.systemDynamic)) {
        contentItems.push({ type: "inputText", text: `\nКонтекст Jarvis:\n${req.systemDynamic ?? ""}\n${notes}` });
      }
      this.rpc.respond(this.delivered.get(result.tool_use_id)!.rpcId, { contentItems, success: !result.is_error });
    }
    this.delivered.clear();
    return true;
  }
  next(): Promise<LlmResponse> {
    if (this.waiter) return Promise.reject(new Error("Codex: параллельный запрос к одной задаче"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.error = new Error("Codex: модель не ответила вовремя"); this.flush(); }, this.timeoutMs);
      this.waiter = { resolve, reject, timer }; this.flush();
    });
  }
  dispose(): void {
    this.unsubscribe(); this.error = new Error("Codex: задача отменена"); this.flush();
    for (const call of [...this.calls, ...this.delivered.values()]) {
      const text = this.delivered.has(call.tool.id)
        ? "Раунд прерван; результат вызова не подтверждён. Не повторять действие автоматически."
        : "Раунд прерван; этот вызов не передан исполнителю Jarvis и не выполнен.";
      this.rpc.respond(call.rpcId, { contentItems: [{ type: "inputText", text }], success: false });
    }
    this.calls = []; this.delivered.clear();
    const interrupted = this.turnId ? this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }) : Promise.resolve();
    void interrupted.catch(() => {}).then(() => this.rpc.request("thread/unsubscribe", { threadId: this.threadId })).catch(() => {});
  }
  private receive(event: RpcMessage): void {
    const p = event.params;
    if (p?.threadId !== this.threadId) return;
    if (event.method === "turn/started") this.turnId = p.turn.id;
    if (event.method === "item/tool/call" && event.id !== undefined) {
      const name = this.names.get(p.tool);
      if (!name || !p.arguments || typeof p.arguments !== "object" || Array.isArray(p.arguments)) {
        this.rpc.respond(event.id, { contentItems: [{ type: "inputText", text: "Неизвестный инструмент или неверные аргументы" }], success: false });
        this.error = new Error("Codex: неожиданный инструмент");
      } else this.calls.push({ rpcId: event.id, tool: { id: p.callId, name, input: p.arguments } });
    }
    // Completed содержит текст даже если клиент не получил отдельные дельты.
    if (event.method === "item/completed" && p.item.type === "agentMessage") this.text += p.item.text;
    if (event.method === "thread/tokenUsage/updated") {
      const u = p.tokenUsage.total;
      this.contextTokens = p.tokenUsage.last?.inputTokens;
      this.total = { inputTokens: Math.max(0, u.inputTokens - u.cachedInputTokens - (u.cacheWriteInputTokens ?? 0)),
        outputTokens: u.outputTokens, cacheReadTokens: u.cachedInputTokens, cacheCreationTokens: u.cacheWriteInputTokens ?? 0 };
    }
    if (event.method === "turn/completed") {
      this.done = true;
      if (p.turn.status !== "completed") this.error = new Error(`Codex: ${p.turn.error?.message ?? p.turn.status}`);
    }
    // Собираем вызовы, пришедшие одним пакетом; более поздние остаются в очереди следующего раунда.
    setImmediate(() => this.flush());
  }
  private flush(): void {
    if (!this.waiter || (!this.error && !this.done && !this.calls.length)) return;
    const waiter = this.waiter; this.waiter = undefined; clearTimeout(waiter.timer);
    if (this.error) { waiter.reject(this.error); return; }
    const calls = this.calls.splice(0);
    for (const call of calls) this.delivered.set(call.tool.id, call);
    const usage = zero();
    for (const key of Object.keys(usage) as (keyof typeof usage)[]) usage[key] = Math.max(0, this.total[key] - this.reported[key]);
    this.reported = { ...this.total };
    const text = this.text; this.text = "";
    waiter.resolve({ text, toolUses: calls.map((c) => c.tool), stopReason: calls.length ? "tool_use" : "end_turn",
      usage, contextTokens: this.contextTokens, stubbed: false, channel: "subscription", modelUsed: this.model });
  }
}

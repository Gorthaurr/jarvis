/** JSONL transport: один собственный процесс, таймауты, EOF и отмена без зависших Promise. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { rmSync } from "node:fs";
import { codexProcessConfig } from "./config.js";

export interface RpcMessage { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string } }
export interface CodexTransport {
  request(method: string, params: unknown): Promise<any>;
  notify(method: string, params?: unknown): void;
  respond(id: number | string, result: unknown): void;
  subscribe(listener: (event: RpcMessage) => void, failed: (error: Error) => void): () => void;
  dispose(): void;
}
export class CodexRpc implements CodexTransport {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<{ event: (v: RpcMessage) => void; failed: (e: Error) => void }>();
  private dead?: Error;
  private cwd: string;
  constructor() {
    const config = codexProcessConfig();
    this.cwd = config.cwd;
    this.child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env, windowsHide: true, shell: false });
    // stderr может содержать чужой контекст; не переносим его в метрики/ответ владельцу.
    this.child.stderr.resume();
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", (code) => this.fail(new Error(`Codex App Server завершился (${code})`)));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let event: RpcMessage;
      try { event = JSON.parse(line); } catch { this.fail(new Error("Codex: некорректный JSONL")); return; }
      if (event.id !== undefined && !event.method) {
        const pending = this.pending.get(Number(event.id));
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(Number(event.id));
        if (event.error) pending.reject(new Error(event.error.message)); else pending.resolve(event.result);
      } else {
        // Никакой неявной выдачи разрешений встроенным исполнителям Codex.
        if (event.id !== undefined && event.method !== "item/tool/call") {
          this.write({ id: event.id, error: { code: -32601, message: "Используйте инструменты Jarvis" } });
          return;
        }
        for (const listener of this.listeners) listener.event(event);
      }
    });
    lines.on("close", () => this.fail(new Error("Codex: поток закрыт")));
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Codex: таймаут ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params?: unknown): void { this.write({ method, params }); }
  respond(id: number | string, result: unknown): void { this.write({ id, result }); }
  subscribe(event: (v: RpcMessage) => void, failed: (e: Error) => void): () => void {
    const listener = { event, failed }; this.listeners.add(listener);
    if (this.dead) queueMicrotask(() => failed(this.dead!));
    return () => this.listeners.delete(listener);
  }
  dispose(): void {
    this.fail(new Error("Codex: остановлен"));
    this.child.stdin.end();
    if (this.child.pid && this.child.exitCode === null) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
      } else this.child.kill();
    }
    try { rmSync(this.cwd, { recursive: true, force: true }); } catch { /* занято при завершении */ }
  }
  private write(value: unknown): void {
    if (!this.dead) this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private fail(error: Error): void {
    if (this.dead) return;
    this.dead = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener.failed(error);
  }
}

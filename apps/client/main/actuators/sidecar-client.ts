/**
 * IPC-клиент к win-сайдкару (§6, §18): UIA-грундинг + SendInput в одном нативном
 * процессе. Протокол — newline-delimited JSON по stdio:
 *   запрос:  {"id":"1","op":"ground","args":{...}}\n
 *   ответ:   {"id":"1","ok":true,"data":{...}}\n  |  {"id":"1","ok":false,"error":"..."}\n
 *
 * Ядро JsonLineRpc отделено от child_process (тестируется без запуска процесса).
 * SidecarClient поднимает реальный exe (extraResources, §3); при отсутствии —
 * ready=false, и актуаторы честно деградируют (dispatch вернёт runtime-ошибку).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createLogger } from "@jarvis/shared";

const log = createLogger("sidecar");

export interface RpcRequest {
  id: string;
  op: string;
  args: Record<string, unknown>;
}
export interface RpcResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Транспорт-независимое ядро RPC: фрейминг + корреляция по id. */
export class JsonLineRpc {
  private buf = "";
  private seq = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly send: (line: string) => void) {}

  /** Отправить запрос и дождаться ответа (или таймаута). */
  request(op: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<unknown> {
    this.seq += 1;
    const id = String(this.seq);
    const req: RpcRequest = { id, op, args };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar timeout op=${op}`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(`${JSON.stringify(req)}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Подать кусок вывода сайдкара (может содержать 0..N полных строк). */
  feed(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handleLine(line);
      nl = this.buf.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let resp: RpcResponse;
    try {
      resp = JSON.parse(line) as RpcResponse;
    } catch {
      log.warn("sidecar: не-JSON строка проигнорирована");
      return;
    }
    const p = this.pending.get(resp.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(resp.id);
    if (resp.ok) p.resolve(resp.data);
    else p.reject(new Error(resp.error ?? "sidecar error"));
  }

  /** Отклонить все ожидающие (процесс умер). */
  rejectAll(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/** Управляет процессом сайдкара и предоставляет RPC. */
export class SidecarClient {
  private child: ChildProcess | null = null;
  private rpc: JsonLineRpc | null = null;
  private _ready = false;

  get ready(): boolean {
    return this._ready;
  }

  /** Поднять сайдкар по пути к exe. Безопасно: при сбое ready=false. */
  start(exePath: string): void {
    try {
      const child = spawn(exePath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      this.rpc = new JsonLineRpc((line) => child.stdin?.write(line));
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => this.rpc?.feed(d));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => log.debug(`sidecar stderr: ${d.trim()}`));
      child.on("error", (e) => {
        log.warn(`sidecar не запустился: ${e.message}`);
        this._ready = false;
        this.rpc?.rejectAll("sidecar process error");
      });
      child.on("exit", (code) => {
        log.warn(`sidecar завершился: code=${code}`);
        this._ready = false;
        this.rpc?.rejectAll("sidecar exited");
      });
      this._ready = true;
      log.info(`sidecar запущен: ${exePath}`);
    } catch (e) {
      log.warn(`не удалось запустить sidecar: ${e instanceof Error ? e.message : String(e)}`);
      this._ready = false;
    }
  }

  /** Выполнить RPC-операцию. Бросает, если сайдкар не готов. */
  request(op: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<unknown> {
    if (!this._ready || !this.rpc) throw new Error("sidecar не готов");
    return this.rpc.request(op, args, timeoutMs);
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.rpc?.rejectAll("sidecar stopped");
    this.rpc = null;
    this._ready = false;
  }
}

/** Синглтон сайдкара на процесс клиента. */
let singleton: SidecarClient | null = null;
export function sidecar(): SidecarClient {
  if (!singleton) singleton = new SidecarClient();
  return singleton;
}

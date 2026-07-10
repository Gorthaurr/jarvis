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

/** Несолиситед-сообщение от сайдкара (без id) — напр. событие записи демонстрации (§8). */
export type PushHandler = (msg: Record<string, unknown>) => void;

/** Транспорт-независимое ядро RPC: фрейминг + корреляция по id. */
export class JsonLineRpc {
  private buf = "";
  private seq = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly send: (line: string) => void,
    /** Обработчик push-строк без id (демо-события, user-takeover). */
    private readonly onPush?: PushHandler,
  ) {}

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
    // Push-строка без id (демо-событие, user-takeover) — отдельный канал, не RPC-ответ.
    if (resp.id === undefined || resp.id === null) {
      this.onPush?.(resp as unknown as Record<string, unknown>);
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

/** §Волна2 (2.4): бэкофф авто-рестарта сайдкара — 1с → ×2 → потолок 30с; сбрасывается аптаймом. */
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
/** Прожил дольше — считаем запуск здоровым, бэкофф сбрасывается (не копится от давних падений). */
const HEALTHY_UPTIME_MS = 60_000;

/** Управляет процессом сайдкара и предоставляет RPC. */
export class SidecarClient {
  private child: ChildProcess | null = null;
  private rpc: JsonLineRpc | null = null;
  private _ready = false;
  private pushHandler: PushHandler | null = null;
  // §Волна2 (2.4): авто-рестарт при падении процесса (раньше падение = «оглох навсегда» до
  // перезапуска клиента). stop() — намеренная остановка, рестарт не планирует.
  private exePath: string | null = null;
  private restartDelayMs = RESTART_BASE_MS;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private stopped = false;

  get ready(): boolean {
    return this._ready;
  }

  /** Подписаться на push-сообщения сайдкара (демо-события записи навыка, §8). */
  onPush(cb: PushHandler): void {
    this.pushHandler = cb;
  }

  /** Поднять сайдкар по пути к exe. Безопасно: при сбое ready=false (+ авто-ретрай с бэкоффом). */
  start(exePath: string): void {
    this.exePath = exePath;
    this.stopped = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      const child = spawn(exePath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      this.startedAt = Date.now();
      this.rpc = new JsonLineRpc(
        (line) => child.stdin?.write(line),
        (msg) => this.pushHandler?.(msg),
      );
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => this.rpc?.feed(d));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => log.debug(`sidecar stderr: ${d.trim()}`));
      child.on("error", (e) => {
        log.warn(`sidecar не запустился: ${e.message}`);
        this._ready = false;
        this.rpc?.rejectAll("sidecar process error");
        this.scheduleRestart();
      });
      child.on("exit", (code) => {
        log.warn(`sidecar завершился: code=${code}`);
        this._ready = false;
        this.rpc?.rejectAll("sidecar exited");
        this.scheduleRestart();
      });
      this._ready = true;
      log.info(`sidecar запущен: ${exePath}`);
    } catch (e) {
      log.warn(`не удалось запустить sidecar: ${e instanceof Error ? e.message : String(e)}`);
      this._ready = false;
      this.scheduleRestart();
    }
  }

  /** §Волна2 (2.4): перезапуск упавшего сайдкара с экспоненциальным бэкоффом (не при stop()). */
  private scheduleRestart(): void {
    if (this.stopped || !this.exePath || this.restartTimer) return;
    // Здоровый аптайм сбрасывает бэкофф: редкое падение стартует ретраи заново с 1с.
    if (Date.now() - this.startedAt > HEALTHY_UPTIME_MS) this.restartDelayMs = RESTART_BASE_MS;
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(RESTART_MAX_MS, this.restartDelayMs * 2);
    log.info(`sidecar: авто-рестарт через ${Math.round(delay / 1000)}с`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && this.exePath) this.start(this.exePath);
    }, delay);
    this.restartTimer.unref?.();
  }

  /** Выполнить RPC-операцию. Бросает, если сайдкар не готов. */
  request(op: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<unknown> {
    if (!this._ready || !this.rpc) throw new Error("sidecar не готов");
    return this.rpc.request(op, args, timeoutMs);
  }

  /** Начать запись демонстрации навыка — UIA-хук в сайдкаре (§8). */
  startDemo(): Promise<unknown> {
    return this.request("demo.record", { op: "start" }, 5000);
  }

  /**
   * Остановить запись — вернуть авторитетный батч пойманных событий (§8).
   * data: { events: Array<{role,name?,action,ts}> }.
   */
  stopDemo(): Promise<{ events?: Array<Record<string, unknown>> }> {
    return this.request("demo.record", { op: "stop" }, 5000) as Promise<{
      events?: Array<Record<string, unknown>>;
    }>;
  }

  stop(): void {
    this.stopped = true; // намеренная остановка — авто-рестарт не планируем
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
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

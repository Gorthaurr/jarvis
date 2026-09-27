/**
 * Persistent мини-CDP-клиент невидимого браузера Джарвиса (вынесен из jarvis-browser.ts, W4 B-14).
 *
 * Раньше соединение игнорировало СОБЫТИЯ CDP (кадры без id) — поэтому ни клик по подложенной ссылке, ни
 * редирект никто не видел. Теперь `on(method, cb)` раздаёт события подписчикам (перехват навигации
 * `Fetch.requestPaused`, смена контекстов исполнения). Общие чистые примитивы — cdp-core.ts.
 */
import { type WsLike, cdpCommand, parseCdpReply, resolveWebSocketCtor, unwrapEvalResult } from "./cdp-core.js";

type EventCb = (params: Record<string, unknown>, sessionId?: string) => void;

export class CdpConn {
  private ws?: WsLike;
  private id = 0;
  private readonly pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private readonly listeners = new Map<string, Set<EventCb>>();
  dead = false;

  connect(wsUrl: string): Promise<void> {
    const WS = resolveWebSocketCtor();
    const ws = new WS(wsUrl);
    this.ws = ws;
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP: WS-таймаут")), 10000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(t); this.dead = true; reject(new Error("CDP: ошибка WS")); });
      ws.addEventListener("message", (ev) => this.onMsg(String(ev.data ?? "")));
      ws.addEventListener("close", () => { this.dead = true; for (const p of this.pending.values()) p.rej(new Error("CDP закрыт")); this.pending.clear(); });
    });
  }

  /** Подписка на событие CDP (метод вида «Fetch.requestPaused»). Возвращает отписку. */
  on(method: string, cb: EventCb): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  private onMsg(data: string): void {
    const m = parseCdpReply(data);
    if (!m) return this.onEvent(data);
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message ?? "CDP error"));
    else p.res(m.result);
  }

  private onEvent(data: string): void {
    let ev: { method?: unknown; params?: unknown; sessionId?: unknown };
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof ev.method !== "string") return;
    const set = this.listeners.get(ev.method);
    if (!set) return;
    const params = ev.params && typeof ev.params === "object" ? (ev.params as Record<string, unknown>) : {};
    const sid = typeof ev.sessionId === "string" ? ev.sessionId : undefined;
    for (const cb of set) {
      try {
        cb(params, sid);
      } catch {
        /* подписчик не валит соединение */
      }
    }
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.id;
    return new Promise<unknown>((resolve, reject) => {
      if (!this.ws || this.dead) return reject(new Error("CDP: нет соединения"));
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP: таймаут ${method}`)); }, 30000);
      this.pending.set(id, { res: (v) => { clearTimeout(timer); resolve(v); }, rej: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify(cdpCommand(id, method, params)));
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const raw = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return unwrapEvalResult<T>(raw, "webK eval");
  }

  close(): void { this.dead = true; try { this.ws?.close(); } catch { /* ignore */ } }
}

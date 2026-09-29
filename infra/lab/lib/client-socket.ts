/**
 * Транспорт лаб-клиента: настоящий WS по протоколу (без Origin), hello, авто-resume при обрыве, outbox для результатов.
 * Всё входящее/исходящее пишется в рекордер. Логику кадров (ping/action/confirm) решает вызывающий через onFrame.
 */
import { type Envelope, PROTOCOL_VERSION, makeEnvelope } from "@jarvis/protocol";
import { WebSocket, type WsLike } from "./deps.js";
import type { EventRecorder } from "./recorder.js";

export interface SocketOptions {
  url: string;
  token: string;
  clientVersion: string;
  rec: EventRecorder;
  onFrame(env: Envelope): void;
  connectTimeoutMs?: number;
  /** Переподключаться с resumeSessionId после неожиданного обрыва (по умолчанию да). */
  reconnect?: boolean;
  /** Оставлять base64-аудио в speak.chunk журнала (аудио-стенду нужны байты озвучки; по умолчанию режем — мегабайты). */
  keepAudio?: boolean;
}

const RETRY_MS = [200, 400, 800, 1600, 3200];

/** Кадры с аудио в журнал кладём без base64 (мегабайты), с размером в audioBytes. */
export function redact(type: string, payload: unknown): unknown {
  if (type !== "speak.chunk" || !payload || typeof payload !== "object") return payload;
  const { audio, ...rest } = payload as Record<string, unknown>;
  return { ...rest, audioBytes: typeof audio === "string" ? Buffer.byteLength(audio, "base64") : 0 };
}

export class LabSocket {
  sessionId = "";
  resumed = false;
  reconnects = 0;
  private ws: WsLike | undefined;
  private closing = false;
  private gaveUp = false;
  private readonly outbox: Array<{ type: string; payload: unknown; id?: string }> = [];
  private ready: Promise<void> = Promise.resolve();

  constructor(private readonly o: SocketOptions) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== "" && this.helloed;
  }
  private helloed = false;

  /** Первое соединение: резолвится после server.hello, отвергается ошибкой/таймаутом (с причиной). */
  connect(): Promise<void> {
    this.ready = this.open(undefined);
    return this.ready;
  }

  private open(resumeSessionId: string | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.o.url, { perMessageDeflate: false });
      this.ws = ws;
      this.helloed = false;
      const timer = setTimeout(() => {
        reject(new Error(`нет server.hello за ${(this.o.connectTimeoutMs ?? 10_000) / 1000} с`));
        ws.terminate();
      }, this.o.connectTimeoutMs ?? 10_000);
      ws.on("open", () => {
        this.write(ws, "client.hello", { token: this.o.token, clientVersion: this.o.clientVersion, protocolVersion: PROTOCOL_VERSION, ...(resumeSessionId ? { resumeSessionId } : {}) });
      });
      ws.on("message", (raw: unknown) => {
        let env: Envelope;
        try {
          env = JSON.parse(String(raw)) as Envelope;
        } catch {
          this.o.rec.push("in", "lab.bad_frame", String(raw).slice(0, 200));
          return;
        }
        this.o.rec.push("in", env.type, this.o.keepAudio ? env.payload : redact(env.type, env.payload), env.id);
        if (env.type === "server.hello") {
          const h = env.payload as { sessionId: string; resumed: boolean };
          this.sessionId = h.sessionId;
          this.resumed = h.resumed;
          this.helloed = true;
          clearTimeout(timer);
          this.flush();
          resolve();
        } else if (env.type === "error" && !this.helloed) {
          clearTimeout(timer);
          const e = env.payload as { code?: string; message?: string };
          reject(new Error(`сервер отверг подключение: ${e.code}: ${e.message}`));
        }
        this.o.onFrame(env);
      });
      ws.on("error", (e: Error) => {
        this.o.rec.push("in", "ws.error", String(e.message));
        if (!this.helloed) {
          clearTimeout(timer);
          reject(new Error(`WebSocket не открылся: ${e.message}`));
        }
      });
      ws.on("close", (code: number, reason: unknown) => {
        this.o.rec.push("in", "ws.close", { code, reason: String(reason ?? "") });
        clearTimeout(timer);
        if (ws !== this.ws) return; // закрылся старый сокет после переподключения
        this.helloed = false;
        if (!this.closing && this.o.reconnect !== false && this.sessionId) void this.reconnectLoop();
      });
    });
  }

  private async reconnectLoop(): Promise<void> {
    for (const wait of RETRY_MS) {
      await new Promise((r) => setTimeout(r, wait));
      if (this.closing) return;
      try {
        this.reconnects += 1;
        this.ready = this.open(this.sessionId);
        await this.ready;
        this.o.rec.push("in", "lab.resumed", { sessionId: this.sessionId, resumed: this.resumed });
        return;
      } catch (e) {
        this.o.rec.push("in", "lab.reconnect_failed", String(e instanceof Error ? e.message : e));
      }
    }
    this.gaveUp = true;
  }

  private write(ws: WsLike, type: string, payload: unknown, id?: string): void {
    const env = makeEnvelope(type as never, payload, id);
    this.o.rec.push("out", type, payload, env.id);
    ws.send(JSON.stringify(env));
  }

  /** Отправить кадр. Нет связи → ошибка (для say/send); `queue:true` — в outbox до resume (результаты действий). */
  send(type: string, payload: unknown, o: { id?: string; queue?: boolean } = {}): void {
    if (this.isOpen && this.ws) return this.write(this.ws, type, payload, o.id);
    if (o.queue && !this.gaveUp && !this.closing) {
      this.outbox.push({ type, payload, ...(o.id ? { id: o.id } : {}) });
      return;
    }
    throw new Error(`лаб-клиент не подключён (${type} не отправлен)`);
  }

  private flush(): void {
    while (this.outbox.length && this.isOpen && this.ws) {
      const m = this.outbox.shift();
      if (m) this.write(this.ws, m.type, m.payload, m.id);
    }
  }

  /** Оборвать сокет без close-рукопожатия (fault drop_socket); резолвится после resume (или ошибкой, если не вернулись). */
  async drop(offlineMs: number): Promise<void> {
    this.ws?.terminate();
    this.o.rec.push("in", "lab.dropped", { offlineMs });
    await new Promise((r) => setTimeout(r, offlineMs));
    const until = Date.now() + 15_000;
    while (!this.isOpen && Date.now() < until && !this.gaveUp) await new Promise((r) => setTimeout(r, 50));
  }

  /** Дождаться связи (после обрыва) — say не должен падать на середине resume. */
  async whenOpen(ms = 5_000): Promise<boolean> {
    const until = Date.now() + ms;
    while (!this.isOpen && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return this.isOpen;
  }

  async close(): Promise<void> {
    this.closing = true;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 2_000);
      ws.on("close", () => {
        clearTimeout(t);
        resolve();
      });
      ws.close(1000, "lab done");
    });
  }
}

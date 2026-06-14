/**
 * STT-провайдер Deepgram (streaming, §10, §12).
 *
 * Реализует стриминговый контракт ISttProvider (voice-providers.ts). Использует
 * встроенный в Node 22 глобальный WebSocket (без пакета 'ws'); авторизация —
 * через subprotocol ["token", <key>] (поддерживается Deepgram). Без ключа —
 * MockSttStream (стаб). RU-качество — bake-off на M1 (§18), провайдер заменяем (§1).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import {
  type ISttProvider,
  MockSttStream,
  type SttOpts,
  type SttPartial,
  type SttStream,
} from "./voice-providers.js";

const log: Logger = createLogger("stt:deepgram");

/** Минимальный контракт глобального WebSocket (браузерный API в Node 22). */
interface WsEvent {
  data?: unknown;
  message?: string;
}
interface WsLike {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "error" | "close", cb: (ev: WsEvent) => void): void;
  readyState: number;
}
type WsCtor = new (url: string, protocols?: string | string[]) => WsLike;

function getWebSocket(): WsCtor | undefined {
  return (globalThis as { WebSocket?: WsCtor }).WebSocket;
}

const DEEPGRAM_WS = "wss://api.deepgram.com/v1/listen";

/**
 * Разобрать сообщение Deepgram в SttPartial (чистая функция — тестируется без сети).
 * Формат Results: { channel:{alternatives:[{transcript,confidence}]}, is_final, speech_final }.
 * Возвращает null для пустых/служебных сообщений.
 */
export function parseDeepgramMessage(raw: unknown): SttPartial | null {
  let msg: unknown = raw;
  if (typeof raw === "string") {
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as {
    type?: string;
    is_final?: boolean;
    speech_final?: boolean;
    channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
  };
  const alt = m.channel?.alternatives?.[0];
  if (!alt) return null;
  const text = (alt.transcript ?? "").trim();
  if (text.length === 0) return null;
  return {
    text,
    final: Boolean(m.is_final ?? m.speech_final ?? false),
    confidence: alt.confidence,
  };
}

/** Собрать query Deepgram под опции стрима (§10: interim_results, endpointing). */
export function buildDeepgramUrl(opts: SttOpts): string {
  const p = new URLSearchParams({
    model: "nova-2",
    language: opts.language ?? "ru",
    encoding: "linear16",
    sample_rate: String(opts.sampleRate),
    interim_results: String(opts.interimResults ?? true),
    punctuate: "true",
    endpointing: "300",
  });
  return `${DEEPGRAM_WS}?${p.toString()}`;
}

class DeepgramSttStream implements SttStream {
  readonly live = true;
  private ws: WsLike | null = null;
  private partialCb?: (p: SttPartial) => void;
  private errorCb?: (e: Error) => void;
  private closeCb?: () => void;
  private open = false;
  private closed = false;
  /** Кадры до открытия сокета буферизуем. */
  private queue: ArrayBuffer[] = [];

  constructor(apiKey: string, opts: SttOpts, WS: WsCtor) {
    try {
      this.ws = new WS(buildDeepgramUrl(opts), ["token", apiKey]);
      this.ws.addEventListener("open", () => {
        this.open = true;
        log.info("deepgram WS открыт — STT в облаке (расход баланса идёт отсюда)");
        for (const f of this.queue) this.ws?.send(f);
        this.queue = [];
      });
      this.ws.addEventListener("message", (ev) => {
        const data = typeof ev.data === "string" ? ev.data : ev.message;
        // ДИАГНОСТИКА: что реально шлёт deepgram (тип, текст, финал/ошибка).
        try {
          const j = JSON.parse(typeof data === "string" ? data : String(data)) as Record<string, unknown>;
          const ch = j.channel as { alternatives?: Array<{ transcript?: string }> } | undefined;
          log.info("deepgram msg", {
            type: j.type,
            transcript: ch?.alternatives?.[0]?.transcript ?? "",
            is_final: j.is_final,
            err: (j.error ?? j.reason ?? j.description) as unknown,
          });
        } catch {
          /* не-JSON кадр */
        }
        const p = parseDeepgramMessage(data);
        if (p) {
          if (p.final) log.info("deepgram транскрипт (финал)", { text: p.text });
          this.partialCb?.(p);
        }
      });
      this.ws.addEventListener("error", () => this.errorCb?.(new Error("deepgram ws error")));
      this.ws.addEventListener("close", () => {
        this.open = false;
        this.closeCb?.();
      });
    } catch (e) {
      this.errorCb?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  pushAudio(pcm: ArrayBuffer): void {
    if (this.closed) return;
    if (this.open && this.ws) this.ws.send(pcm);
    else this.queue.push(pcm);
  }
  onPartial(cb: (p: SttPartial) => void): void {
    this.partialCb = cb;
  }
  onError(cb: (e: Error) => void): void {
    this.errorCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.open && this.ws) this.ws.send(JSON.stringify({ type: "CloseStream" }));
      this.ws?.close();
    } catch {
      /* сокет уже мёртв */
    }
  }
}

export class DeepgramSttProvider implements ISttProvider {
  readonly live: boolean;
  constructor(private readonly apiKey: string | undefined) {
    this.live = Boolean(apiKey) && getWebSocket() !== undefined;
    if (!apiKey) log.warn("DEEPGRAM_API_KEY не задан — STT в mock-режиме");
    else if (getWebSocket() === undefined) log.warn("глобальный WebSocket недоступен — STT в mock-режиме");
  }

  open(opts: SttOpts): SttStream {
    const WS = getWebSocket();
    if (!this.apiKey || !WS) return new MockSttStream();
    return new DeepgramSttStream(this.apiKey, opts, WS);
  }
}

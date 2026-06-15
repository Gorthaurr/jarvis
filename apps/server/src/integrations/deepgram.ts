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

/**
 * Подсказки распознавания (§10): имя-будильник + частые имена сервисов/приложений.
 * nova-3 keyterm prompting резко поднимает точность собственных имён («Джарвис»,
 * «Телеграм») в русской речи — то, что локальный Whisper в transformers.js не умеет.
 */
const KEYTERMS = [
  "Джарвис",
  "Телеграм",
  "ВКонтакте",
  "Ютуб",
  "Инстаграм",
  "Спотифай",
  "Гугл",
  "Хром",
  "Ворд",
  "Эксель",
  "блокнот",
  "браузер",
];

/** Собрать query Deepgram под опции стрима (§10: interim_results, endpointing, keyterm). */
export function buildDeepgramUrl(opts: SttOpts): string {
  // nova-3 (env DEEPGRAM_MODEL для отката на nova-2): лучше русский WER + keyterm prompting.
  const p = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-3",
    language: opts.language ?? "ru",
    encoding: "linear16",
    sample_rate: String(opts.sampleRate),
    interim_results: String(opts.interimResults ?? true),
    smart_format: "true",
    endpointing: "300",
  });
  // keyterm работает только на nova-3; на nova-2 параметр просто игнорируется.
  for (const kt of KEYTERMS) p.append("keyterm", kt);
  return `${DEEPGRAM_WS}?${p.toString()}`;
}

/**
 * Адаптивное усиление тихого потока (§10). Браузерный autoGainControl даёт пик ~0.07 —
 * Whisper это вытягивает своим усилением, а Deepgram на таком тихом raw-PCM возвращает
 * ПУСТО (доказанный баг). Тянем огибающую пика к целевому уровню с клампом против клиппинга;
 * тишину не раздуваем (иначе фантомы). Стримовый аналог normalizeAudio из whisper-stt.
 */
export class StreamAgc {
  private envelope = 0;
  constructor(
    private readonly targetPeak = 0.25,
    private readonly maxGain = 6,
    private readonly decay = 0.97,
  ) {}

  boost(pcm: ArrayBuffer): ArrayBuffer {
    const n = Math.floor(pcm.byteLength / 2);
    if (n === 0) return pcm;
    const src = new DataView(pcm);
    let peak = 0;
    for (let i = 0; i < n; i += 1) {
      const v = Math.abs(src.getInt16(i * 2, true)) / 32768;
      if (v > peak) peak = v;
    }
    this.envelope = Math.max(peak, this.envelope * this.decay);
    if (this.envelope < 1e-4) return pcm; // тишина — не усиливаем
    const gain = Math.min(this.maxGain, this.targetPeak / this.envelope);
    if (gain <= 1.05) return pcm;
    const out = new ArrayBuffer(pcm.byteLength);
    const dst = new DataView(out);
    for (let i = 0; i < n; i += 1) {
      const s = Math.round(src.getInt16(i * 2, true) * gain);
      dst.setInt16(i * 2, Math.max(-32768, Math.min(32767, s)), true);
    }
    return out;
  }
}

/** Извлечь (transcript, isFinal, speechFinal) из сырого сообщения Deepgram. */
function readResults(raw: unknown): { text: string; isFinal: boolean; speechFinal: boolean } | null {
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
    is_final?: boolean;
    speech_final?: boolean;
    channel?: { alternatives?: Array<{ transcript?: string }> };
  };
  const text = (m.channel?.alternatives?.[0]?.transcript ?? "").trim();
  return { text, isFinal: Boolean(m.is_final), speechFinal: Boolean(m.speech_final) };
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
  /** Усилитель тихого потока (см. StreamAgc) — на сессию стрима. */
  private readonly agc = new StreamAgc();
  /**
   * Накопление утверждённых сегментов (is_final) в полную фразу. Deepgram шлёт фразу
   * сегментами; финал в пайплайн отдаём ОДИН раз — на close() (эндпоинт ведёт VAD
   * пайплайна, как у Whisper). Так нет дробления/мульти-триггера и нет инференс-задержки.
   */
  private committed = "";
  private lastInterim = "";

  constructor(apiKey: string, opts: SttOpts, WS: WsCtor) {
    try {
      this.ws = new WS(buildDeepgramUrl(opts), ["token", apiKey]);
      this.ws.addEventListener("open", () => {
        // Сокет мог быть закрыт ДО открытия (короткий оборот/barge-in): не оживляем,
        // иначе утечём WS-соединением и продолжим жечь баланс на «закрытом» стриме.
        if (this.closed) {
          try {
            this.ws?.close();
          } catch {
            /* уже мёртв */
          }
          return;
        }
        this.open = true;
        log.info("deepgram WS открыт — STT в облаке (расход баланса идёт отсюда)");
        for (const f of this.queue) this.ws?.send(f);
        this.queue = [];
      });
      this.ws.addEventListener("message", (ev) => {
        const data = typeof ev.data === "string" ? ev.data : ev.message;
        const r = readResults(data);
        if (!r) return;
        // is_final — сегмент утверждён: добавляем в накопленную фразу. Иначе — interim.
        if (r.isFinal) {
          if (r.text) this.committed = this.committed ? `${this.committed} ${r.text}` : r.text;
          this.lastInterim = "";
        } else {
          this.lastInterim = r.text;
        }
        // Живой (нефинальный) транскрипт — для UI и turn-детектора пайплайна.
        const live = [this.committed, this.lastInterim].filter(Boolean).join(" ").trim();
        if (live) this.partialCb?.({ text: live, final: false });
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
    const boosted = this.agc.boost(pcm); // тихий поток → Deepgram молчит; усиливаем
    if (this.open && this.ws) this.ws.send(boosted);
    else this.queue.push(boosted);
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
    this.queue = []; // сбрасываем недослатые кадры — стрим завершён
    // Финал в пайплайн — ОДИН раз, накопленной фразой (эндпоинт ведёт VAD пайплайна).
    // Текст уже распознан стримом → без инференс-задержки (главный выигрыш над Whisper).
    const finalText = [this.committed, this.lastInterim].filter(Boolean).join(" ").trim();
    if (finalText) {
      log.info("deepgram транскрипт (финал)", { text: finalText });
      this.partialCb?.({ text: finalText, final: true });
    }
    this.committed = "";
    this.lastInterim = "";
    try {
      if (this.open && this.ws) this.ws.send(JSON.stringify({ type: "CloseStream" }));
      // Закрываем сокет ВСЕГДА, даже если open ещё не наступил (CONNECTING):
      // иначе сокет, открывшийся после close(), останется висеть.
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

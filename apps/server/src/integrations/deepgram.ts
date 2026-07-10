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
  /** На close-событии: код/причина закрытия (диагностика «почему deepgram молчит», §10). */
  code?: number;
  reason?: string;
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

/** Кэп буфера недосланных кадров (~5с при кадре ~32мс) — против неогранич. роста на зависшем WS. */
const MAX_QUEUED_FRAMES = 160;
/** Сколько раз подряд пробуем переподключить стрим при сетевом обрыве посреди фразы (§10). */
const MAX_RECONNECTS = 5;

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
  const model = process.env.DEEPGRAM_MODEL || "nova-3";
  const p = new URLSearchParams({
    model,
    language: opts.language ?? "ru",
    encoding: "linear16",
    sample_rate: String(opts.sampleRate),
    interim_results: String(opts.interimResults ?? true),
    smart_format: "true",
    endpointing: "300",
  });
  // keyterm — по умолчанию ВЫКЛ. Подозрение №1 в «deepgram молчит на живом стриме»: 12
  // кириллических keyterm на nova-3 в потоковом режиме → сокет открыт, но ноль Results
  // (исследование §10). Точность имён добираем NLU-слоем (disfluency+fuzzy), realtime важнее.
  // Включить: DEEPGRAM_KEYTERM=1 (только nova-3 — на nova-2 keyterm ВАЛИТ WS-хендшейк).
  if (process.env.DEEPGRAM_KEYTERM === "1" && model.startsWith("nova-3")) {
    for (const kt of KEYTERMS) p.append("keyterm", kt);
  }
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
  /** Диагностика (§10): сколько кадров ушло / сообщений пришло / пик после буста. */
  private framesSent = 0;
  private msgCount = 0;
  private peakSeen = 0;
  /** Резолвер «дослали финал» (§10): close() ждёт Metadata от deepgram, не рвёт сокет синхронно. */
  private flushResolve: (() => void) | null = null;
  /** Резолвер «сокет открылся» (§10): close() короткой фразы ждёт хендшейк, чтобы не выбросить буфер. */
  private openResolve: (() => void) | null = null;
  /** KeepAlive-таймер (§10): не дать deepgram оборвать WS по простою (~10с) в follow-up окне. */
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastAudioAt = 0;
  /** Для reconnect-in-stream: параметры пересоздания сокета. */
  private readonly apiKey: string;
  private readonly opts: SttOpts;
  private readonly WS: WsCtor;
  /** Сколько реконнектов подряд уже сделали (сбрасывается на успешном open). */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** closeCb отдаём в пайплайн РОВНО один раз (иначе двойное переоткрытие STT). */
  private closeNotified = false;

  constructor(apiKey: string, opts: SttOpts, WS: WsCtor) {
    this.apiKey = apiKey;
    this.opts = opts;
    this.WS = WS;
    this.connect();
  }

  /** Создать WS и навесить слушатели. Вызывается при старте и при reconnect (§10). */
  private connect(): void {
    try {
      this.ws = new this.WS(buildDeepgramUrl(this.opts), ["token", this.apiKey]);
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
        this.reconnectAttempts = 0; // успешно поднялись — бюджет реконнектов сброшен
        log.info("deepgram WS открыт — STT в облаке (расход баланса идёт отсюда)");
        for (const f of this.queue) this.ws?.send(f);
        this.queue = [];
        this.openResolve?.(); // close() короткой фразы мог ждать хендшейк — буфер ушёл, можно финализировать
        this.openResolve = null;
        this.armKeepAlive(); // §10: держим WS живым в паузах (иначе дроп по простою ~10с)
      });
      this.ws.addEventListener("message", (ev) => {
        const data = typeof ev.data === "string" ? ev.data : ev.message;
        this.msgCount += 1;
        let m: { type?: string; is_final?: boolean; channel?: { alternatives?: Array<{ transcript?: string }> } };
        try {
          m = JSON.parse(String(data));
        } catch {
          return;
        }
        // Диагностика (§10): первые сообщения целиком — отличить «deepgram молчит» от «шлёт не-Results».
        if (this.msgCount <= 5) log.info("deepgram сообщение", { n: this.msgCount, type: m?.type, raw: String(data).slice(0, 200) });
        // Metadata — последнее сообщение перед закрытием: им deepgram сигналит «всё дослал» (§10).
        if (m?.type === "Metadata") {
          this.flushResolve?.();
          this.flushResolve = null;
          return;
        }
        const text = (m?.channel?.alternatives?.[0]?.transcript ?? "").trim();
        if (!text) return;
        // is_final — сегмент утверждён: добавляем в накопленную фразу. Иначе — interim.
        if (m.is_final) {
          this.committed = this.committed ? `${this.committed} ${text}` : text;
          this.lastInterim = "";
        } else {
          this.lastInterim = text;
        }
        // Живой (нефинальный) транскрипт — для UI и turn-детектора пайплайна.
        const live = [this.committed, this.lastInterim].filter(Boolean).join(" ").trim();
        if (live) this.partialCb?.({ text: live, final: false });
      });
      // §10: сетевой сбой посреди стрима НЕ шлём в пайплайн как фатальный (был спам 174×) —
      // решение reconnect/финал принимает close-обработчик. Только лог.
      this.ws.addEventListener("error", () => log.warn("deepgram ws error (переподключусь, если уместно)"));
      this.ws.addEventListener("close", (ev) => {
        // §10: код/причина закрытия — прямая диагностика «почему deepgram молчит» (keyterm/limit/format).
        log.info("deepgram WS закрыт", { code: ev?.code, reason: String(ev?.reason ?? "").slice(0, 120), msgs: this.msgCount });
        this.open = false;
        this.clearKeepAlive();
        // НЕОЖИДАННЫЙ обрыв (не наш close()) с транзиентным кодом и в пределах бюджета → reconnect:
        // committed/lastInterim/очередь кадров СОХРАНЕНЫ → финал хода не теряем (P1 no-network-reconnect).
        if (!this.closed && this.shouldReconnect(ev?.code)) {
          this.scheduleReconnect();
          return;
        }
        // Наш close() ждёт Metadata/таймаут — будим его; финал отдаст сам close().
        this.flushResolve?.();
        this.flushResolve = null;
        this.notifyClose();
      });
    } catch (e) {
      // Синхронный сбой конструктора WS: пробуем reconnect, иначе отдаём ошибку наверх.
      if (!this.closed && this.shouldReconnect()) this.scheduleReconnect();
      else {
        this.errorCb?.(e instanceof Error ? e : new Error(String(e)));
        this.notifyClose();
      }
    }
  }

  /** Стоит ли переподключаться: бюджет не исчерпан, закрытие не штатное (1000) и не auth/policy. */
  private shouldReconnect(code?: number): boolean {
    if (this.reconnectAttempts >= MAX_RECONNECTS) return false;
    if (code === 1000) return false; // нормальное закрытие — не сетевой сбой
    if (code === 1008 || code === 4001 || code === 4003 || code === 4008) return false; // auth/policy — не поможет
    return true;
  }

  /** Запланировать reconnect с экспоненциальным backoff (200→2000мс), сохранив накопленный транскрипт. */
  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(2000, 200 * 2 ** (this.reconnectAttempts - 1));
    log.warn("deepgram: переподключение стрима", { attempt: this.reconnectAttempts, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.connect();
    }, delay);
    if (typeof this.reconnectTimer === "object" && "unref" in this.reconnectTimer) this.reconnectTimer.unref?.();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Сообщить пайплайну о закрытии стрима РОВНО один раз. */
  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.closeCb?.();
  }

  pushAudio(pcm: ArrayBuffer): void {
    if (this.closed) return;
    this.lastAudioAt = Date.now(); // §10: для KeepAlive — был ли недавно звук
    const boosted = this.agc.boost(pcm); // тихий поток → Deepgram молчит; усиливаем
    // Диагностика (§10): пик после буста + счётчик кадров — видно, доходит ли аудио и какого уровня.
    const dv = new DataView(boosted);
    for (let i = 0; i + 1 < boosted.byteLength; i += 2) {
      const v = Math.abs(dv.getInt16(i, true)) / 32768;
      if (v > this.peakSeen) this.peakSeen = v;
    }
    this.framesSent += 1;
    if (this.framesSent % 150 === 1) {
      log.info("deepgram: аудио идёт", { frames: this.framesSent, peak: this.peakSeen.toFixed(3), msgs: this.msgCount, open: this.open });
    }
    if (this.open && this.ws) this.ws.send(boosted);
    else {
      // Сокет ещё не открылся (или завис на хендшейке) — буферизуем кадры. Кольцевой буфер с
      // вытеснением старых: на зависшем коннекте без кэпа очередь росла бы неограниченно (рост
      // памяти). 5с свежего аудио достаточно, чтобы догнать после открытия; старое всё равно протухло.
      this.queue.push(boosted);
      if (this.queue.length > MAX_QUEUED_FRAMES) this.queue.shift();
    }
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
    // §10 НЕ ТЕРЯТЬ КОРОТКУЮ ФРАЗУ: если WS ещё в хендшейке, а в очереди есть аудио — дождёмся
    // открытия (open-хендлер отправит буфер), и лишь потом финализируем. Раньше queue выбрасывался
    // и CloseStream не слался (не open) → Deepgram получал НОЛЬ → «РЕЧЬ ПОТЕРЯНА» на быстрых командах.
    if (!this.open && this.ws && this.queue.length > 0) {
      await this.waitForOpen(800);
    }
    this.closed = true;
    this.queue = []; // сбрасываем недослатые кадры — стрим завершён
    this.clearKeepAlive();
    this.clearReconnect(); // отменяем запланированный reconnect — стрим закрывает вызывающий

    // §10 КРИТИЧНО: deepgram СТРИМИНГОВЫЙ — после CloseStream он ещё ДОСЫЛАЕТ буферизованные
    // Results и завершает Metadata. Раньше close() рвал сокет СИНХРОННО → на живом потоке финал
    // не успевал прийти (в отличие от батч-Whisper, который держит всё аудио). Теперь: шлём
    // CloseStream, ЖДЁМ Metadata (или таймаут), и только потом собираем финал и рвём сокет.
    try {
      if (this.open && this.ws) this.ws.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      /* сокет уже мёртв */
    }
    // §10: ЖДЁМ Metadata (deepgram досылает ФИНАЛ буфера ПОСЛЕ CloseStream). Реальный тест поймал:
    // при коротком ожидании (200мс) терялось ПОСЛЕДНЕЕ слово фразы («погода»: interim «сегодня
    // хороший» сидел, финал «…хорошая погода» не успевал). waitForFlush резолвится РАНО на Metadata
    // (обычно ~100–300мс) → латентность почти не растёт; 800 — лишь страховочный кэп.
    if (this.open) {
      await this.waitForFlush(800);
    }

    const finalText = [this.committed, this.lastInterim].filter(Boolean).join(" ").trim();
    if (finalText) {
      log.info("deepgram транскрипт (финал)", { text: finalText });
      this.partialCb?.({ text: finalText, final: true });
    } else {
      // Диагностика (§10): ПУСТОЙ финал. РАЗЛИЧАЕМ два случая, чтобы реальная боль «не слышит» была
      // видна, а тишина не зашумляла err-лог (форензика 2026-06-18: 726 пустых финалов, бóльшая часть —
      // тишина/VAD-ложняк):
      //  - был ЗВУК РЕЧИ (peak≥0.15) и кадры (≥40 ≈ 0.5с), а транскрипта нет → ПОТЕРЯ РЕАЛЬНОЙ РЕЧИ (WARN,
      //    вероятный корень — WS-churn рвёт финал; чинить persistent Deepgram WS);
      //  - тихо/мало кадров/0 сообщений → тишина или ложный VAD-триггер (debug, это норма).
      const info = { frames: this.framesSent, peak: this.peakSeen.toFixed(3), msgs: this.msgCount };
      if (this.peakSeen >= 0.15 && this.framesSent >= 40) {
        log.warn("deepgram: РЕЧЬ ПОТЕРЯНА — был звук, а транскрипта нет (вероятно WS-churn рвёт финал)", info);
      } else {
        log.debug("deepgram: пустой финал (тишина/ложный VAD — норма)", info);
      }
    }
    this.committed = "";
    this.lastInterim = "";
    try {
      this.ws?.close();
    } catch {
      /* уже мёртв */
    }
  }

  /** §10: дождаться открытия WS (хендшейк) либо таймаута — чтобы close() короткой фразы не выбросил буфер. */
  private waitForOpen(ms: number): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.openResolve = null;
        resolve();
      }, ms);
      if (typeof t === "object" && "unref" in t) t.unref?.();
      this.openResolve = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  /** §10: дождаться Metadata от deepgram (он шлёт его последним) либо таймаута — финал не теряем. */
  private waitForFlush(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.flushResolve = null;
        resolve();
      }, ms);
      if (typeof t === "object" && "unref" in t) t.unref?.();
      this.flushResolve = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  /** §10: периодический KeepAlive — не дать deepgram оборвать WS по простою (~10с) между фразами. */
  private armKeepAlive(): void {
    this.clearKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.closed || !this.open || !this.ws) return;
      if (Date.now() - this.lastAudioAt < 5000) return; // звук был недавно — не нужно
      try {
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
      } catch {
        /* сокет умер — close-листенер уберёт таймер */
      }
    }, 4000);
    if (typeof this.keepAliveTimer === "object" && "unref" in this.keepAliveTimer) this.keepAliveTimer.unref?.();
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}

// ── ПЕРСИСТЕНТНЫЙ WS (§10, боль #1: убрать per-utterance churn — теряет ~половину речи) ───────────

/** Кэп буфера аудио ТЕКУЩЕГО хода для replay при reconnect (~30с при ~32мс/кадр). */
const MAX_TURN_AUDIO_FRAMES = 1000;
/** Тишина дольше — усыпляем сокет (откроется на следующей речи), не держим вечно открытым. */
const IDLE_SLEEP_MS = 120_000;
/**
 * Печать хода — по ТИШИНЕ после Finalize, не по первому is_final (§10, фикс кросс-ход утечки + tail-loss).
 * Deepgram на общем сокете шлёт ход сегментами; ранний выход по первому is_final (а) терял последнее слово
 * и (б) оставлял хвост в полёте → он протекал в СЛЕДУЮЩИЙ ход. Ждём, пока сегменты перестанут приходить
 * (SEAL_QUIET_MS тишины) — тогда ход дослан ПОЛНОСТЬЮ и слит ДО старта следующего. Кэп — SEAL_MAX_MS.
 */
const SEAL_QUIET_MS = (() => {
  const n = Number.parseInt(process.env.JARVIS_DEEPGRAM_SEAL_QUIET_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 800; // фолбэк-тишина (на хвост-тишину без Results); основной критерий — processedSec≥turnEndSec
})();
const SEAL_MAX_MS = 3000;

/**
 * Классификация пустого финала (§10): потерянный кусок РЕЧИ или тишина/ложный VAD. Чистая функция.
 */
export function classifyEmptyFinal(d: { peak: number; frames: number }): "lost" | "silence" {
  return d.peak >= 0.15 && d.frames >= 40 ? "lost" : "silence";
}

/**
 * Per-turn handle поверх персистентного сокета (§10). Пайплайн видит его как обычный SttStream:
 * open() отдаёт НОВЫЙ LeasedTurn каждый ход → onPartial/onClose-замыкания per-ход целы (speaker-gate
 * пайплайна работает без правок). close() = finalizeTurn (сокет НЕ трогаем — он живёт дальше).
 */
class LeasedTurn implements SttStream {
  readonly live = true;
  private partialCb?: (p: SttPartial) => void;
  private closeCb?: () => void;
  private closeNotified = false;
  private done = false;
  constructor(
    private readonly conn: PersistentDeepgramConnection,
    readonly turn: number,
  ) {}
  pushAudio(pcm: ArrayBuffer): void {
    if (!this.done) this.conn.pushAudioForTurn(this.turn, pcm);
  }
  onPartial(cb: (p: SttPartial) => void): void {
    this.partialCb = cb;
  }
  // biome-ignore lint/suspicious/noEmptyBlockStatements: ошибки хода идут через notifyClose (реальная смерть сокета)
  onError(_cb: (e: Error) => void): void {}
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  async close(): Promise<void> {
    if (this.done) return;
    this.done = true;
    await this.conn.finalizeTurn(this.turn);
  }
  emitPartial(p: SttPartial): void {
    this.partialCb?.(p);
  }
  /** ТОЛЬКО на реальной смерти сокета (бюджет reconnect/auth/dispose), НЕ между ходами. */
  notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.closeCb?.();
  }
}

/**
 * Персистентное соединение с Deepgram: ОДИН сокет переживает много ходов сессии (§10). Ход
 * финализируется Finalize-сообщением (сокет не рвём), сегментацию ведёт VAD пайплайна. Generation-
 * гейтинг (activeTurn) не даёт поздним Results прошлого хода протечь в следующий. См. spec wbtv6gp86.
 */
class PersistentDeepgramConnection {
  private ws: WsLike | null = null;
  private open = false;
  private disposed = false;
  // ход
  private turnGen = 0;
  private activeTurn = -1;
  private turnState: "idle" | "active" | "sealing" = "idle";
  private committed = "";
  private lastInterim = "";
  private finalEmittedForTurn = -1;
  private currentLease: LeasedTurn | null = null;
  // finalize-ожидание: печать по ТИШИНЕ (нет новых сегментов SEAL_QUIET_MS) либо по кэпу/Metadata
  private sealResolve: (() => void) | null = null;
  private sealQuietTimer: ReturnType<typeof setTimeout> | null = null;
  private sealMaxTimer: ReturnType<typeof setTimeout> | null = null;
  // аудио-буфер текущего хода (для reconnect-replay) — единственная очередь
  private turnAudioBuffer: ArrayBuffer[] = [];
  // диагностика per-turn
  private framesSent = 0;
  private msgCount = 0;
  private peakSeen = 0;
  // §10 ГРАНИЦА ХОДА ПО ПОЗИЦИИ АУДИО (Deepgram даёт start/duration в таймлайне сокета). Результат
  // принадлежит ходу, только если его аудио ≥ turnStartSec; хвост прошлого хода (start < turnStartSec)
  // ДРОПается, даже придя во время следующего → нет кросс-ход утечки. Печать — когда Deepgram обработал
  // всю длительность хода (processedSec ≥ turnEndSec). Надёжнее «таймера тишины»: не зависит от лага сети.
  private sentSec = 0; // суммарно отослано аудио на ЭТОТ сокет (сек)
  private turnStartSec = 0; // позиция начала аудио текущего хода
  private turnEndSec = 0; // позиция конца хода (ставится на finalize)
  private processedSec = 0; // max(start+duration) среди полученных результатов
  // reconnect / keepalive / idle
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private idleSleepTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAudioAt = 0;
  private openResolve: (() => void) | null = null;
  private readonly agc = new StreamAgc();
  private readonly fmtSampleRate: number;
  private readonly fmtLanguage: string;

  constructor(
    private readonly apiKey: string,
    private readonly opts: SttOpts,
    private readonly WS: WsCtor,
  ) {
    this.fmtSampleRate = opts.sampleRate;
    this.fmtLanguage = opts.language ?? "ru";
  }

  isDisposed(): boolean {
    return this.disposed;
  }
  sameFormat(opts: SttOpts): boolean {
    return opts.sampleRate === this.fmtSampleRate && (opts.language ?? "ru") === this.fmtLanguage;
  }

  /** Начать ход: вернуть лёгкий LeasedTurn поверх (пере)используемого сокета. */
  beginTurn(opts: SttOpts): LeasedTurn {
    if (this.activeTurn >= 0 || this.turnState === "sealing") this.abandonTurn(); // barge-in поверх незакрытого
    this.clearIdleSleep();
    this.turnGen += 1;
    const turn = this.turnGen;
    this.activeTurn = turn;
    this.turnState = "active";
    this.committed = "";
    this.lastInterim = "";
    this.finalEmittedForTurn = -1;
    this.turnAudioBuffer = [];
    this.framesSent = 0;
    this.msgCount = 0;
    this.peakSeen = 0;
    this.turnStartSec = this.sentSec; // граница: аудио этого хода начинается с текущей позиции таймлайна
    this.turnEndSec = Number.POSITIVE_INFINITY; // конца ещё нет — поставим на finalize
    this.ensureConnected(opts);
    const lease = new LeasedTurn(this, turn);
    this.currentLease = lease;
    return lease;
  }

  /** Бросить незакрытый предыдущий ход молча (barge-in: пайплайн его gen уже инвалидировал). */
  private abandonTurn(): void {
    this.sealNow();
    this.activeTurn = -1;
    this.turnState = "idle";
    this.committed = "";
    this.lastInterim = "";
    this.turnAudioBuffer = [];
  }

  private ensureConnected(_opts: SttOpts): void {
    if (this.disposed) return;
    if (!this.ws && !this.reconnectTimer) this.connect();
  }

  pushAudioForTurn(turn: number, pcm: ArrayBuffer): void {
    if (turn !== this.activeTurn) return; // аудио чужого/завершённого хода — игнор
    this.lastAudioAt = Date.now();
    const boosted = this.agc.boost(pcm);
    this.sentSec += boosted.byteLength / (this.fmtSampleRate * 2); // s16le mono: 2 байта/семпл
    const dv = new DataView(boosted);
    for (let i = 0; i + 1 < boosted.byteLength; i += 2) {
      const v = Math.abs(dv.getInt16(i, true)) / 32768;
      if (v > this.peakSeen) this.peakSeen = v;
    }
    this.framesSent += 1;
    if (this.framesSent % 150 === 1) {
      log.info("deepgram: аудио идёт (персист)", { frames: this.framesSent, peak: this.peakSeen.toFixed(3), msgs: this.msgCount, open: this.open });
    }
    this.turnAudioBuffer.push(boosted);
    if (this.turnAudioBuffer.length > MAX_TURN_AUDIO_FRAMES) this.turnAudioBuffer.shift();
    if (this.open && this.ws) this.ws.send(boosted);
  }

  /** Финализировать ТОЛЬКО свой ход: Finalize → дождаться is_final/таймаут → emitFinal. Сокет жив. */
  async finalizeTurn(turn: number): Promise<void> {
    if (turn !== this.activeTurn || this.turnState !== "active") {
      this.emitFinal(turn); // идемпотентно/no-op для брошенного/чужого хода
      return;
    }
    this.turnState = "sealing";
    this.turnEndSec = this.sentSec; // вся длительность хода отослана — печать, когда Deepgram её обработает
    if (!this.open && this.ws && this.turnAudioBuffer.length > 0) await this.waitForOpen(800);
    try {
      if (this.open && this.ws) this.ws.send(JSON.stringify({ type: "Finalize" })); // НЕ CloseStream!
    } catch {
      /* сокет мёртв — emitFinal отдаст что накоплено */
    }
    // Ждём ПОЛНУЮ досылку хода: копим сегменты is_final, пока Deepgram не замолчит SEAL_QUIET_MS (или
    // не подтвердит Metadata, или не выйдет кэп). Лечит tail-loss (последнее слово) И кросс-ход утечку
    // (хвост полностью слит ДО возврата → следующий ход стартует чистым).
    await this.drainSeal();
    this.emitFinal(turn);
  }

  /** Выдать финал ровно один раз на ход и запечатать ход (поздние Results после — дроп). */
  private emitFinal(turn: number): void {
    if (this.finalEmittedForTurn === turn || turn !== this.activeTurn) return;
    this.finalEmittedForTurn = turn;
    const finalText = [this.committed, this.lastInterim].filter(Boolean).join(" ").trim();
    const diag = { frames: this.framesSent, peak: this.peakSeen.toFixed(3), msgs: this.msgCount };
    // запечатать ДО колбэка
    this.activeTurn = -1;
    this.turnState = "idle";
    const lease = this.currentLease;
    this.currentLease = null;
    this.committed = "";
    this.lastInterim = "";
    this.turnAudioBuffer = [];
    if (finalText) {
      log.info("deepgram транскрипт (финал, персист)", { text: finalText });
      lease?.emitPartial({ text: finalText, final: true });
    } else if (classifyEmptyFinal({ peak: this.peakSeen, frames: this.framesSent }) === "lost") {
      log.warn("deepgram: РЕЧЬ ПОТЕРЯНА — был звук, а транскрипта нет (персист)", diag);
    } else {
      log.debug("deepgram: пустой финал (тишина/ложный VAD — норма)", diag);
    }
    this.framesSent = 0;
    this.msgCount = 0;
    this.peakSeen = 0;
    this.armIdleSleep(); // нет активного хода — запускаем усыпление
  }

  /** Печать хода по ТИШИНЕ: ждём, пока сегменты перестанут приходить (или кэп/Metadata). */
  private drainSeal(): Promise<void> {
    return new Promise((resolve) => {
      this.sealResolve = () => {
        this.clearSealTimers();
        this.sealResolve = null;
        resolve();
      };
      // Вся длительность хода уже обработана (или ход без аудио) → печать СРАЗУ, без ожидания.
      if (this.processedSec >= this.turnEndSec - 0.1) {
        this.sealResolve();
        return;
      }
      this.sealMaxTimer = setTimeout(() => this.sealResolve?.(), SEAL_MAX_MS); // страховочный кэп
      if (typeof this.sealMaxTimer === "object" && "unref" in this.sealMaxTimer) this.sealMaxTimer.unref?.();
      this.bumpSealQuiet(); // стартовое окно: нет сегментов SEAL_QUIET_MS → печать
    });
  }
  /** Сегмент/interim во время sealing → продлить окно тишины (ход ещё досылается). */
  private bumpSealQuiet(): void {
    if (!this.sealResolve) return;
    if (this.sealQuietTimer) clearTimeout(this.sealQuietTimer);
    this.sealQuietTimer = setTimeout(() => this.sealResolve?.(), SEAL_QUIET_MS);
    if (typeof this.sealQuietTimer === "object" && "unref" in this.sealQuietTimer) this.sealQuietTimer.unref?.();
  }
  /** Печать немедленно (Metadata-подтверждение, barge-in, смерть сокета). */
  private sealNow(): void {
    this.sealResolve?.();
  }
  private clearSealTimers(): void {
    if (this.sealQuietTimer) {
      clearTimeout(this.sealQuietTimer);
      this.sealQuietTimer = null;
    }
    if (this.sealMaxTimer) {
      clearTimeout(this.sealMaxTimer);
      this.sealMaxTimer = null;
    }
  }

  private connect(): void {
    if (this.disposed) return;
    try {
      this.ws = new this.WS(buildDeepgramUrl(this.opts), ["token", this.apiKey]);
      this.ws.addEventListener("open", () => {
        if (this.disposed) {
          try {
            this.ws?.close();
          } catch {
            /* уже мёртв */
          }
          return;
        }
        this.open = true;
        this.reconnectAttempts = 0;
        log.info("deepgram WS открыт — STT в облаке (персистентный, расход баланса идёт отсюда)");
        if (this.activeTurn >= 0) {
          // первичный старт ИЛИ reconnect mid-turn: пересобрать committed С НУЛЯ + реплей буфера
          // хода (тот же replay даст Deepgram то же аудио → committed без сброса = дубль текста).
          // Таймлайн нового сокета у Deepgram стартует с 0 → ОБНУЛЯЕМ счётчик позиции и пересчитываем
          // его по реплею (иначе сравнение start/turnStartSec поедет).
          this.committed = "";
          this.lastInterim = "";
          this.sentSec = 0;
          this.processedSec = 0;
          this.turnStartSec = 0;
          for (const f of this.turnAudioBuffer) {
            this.ws?.send(f);
            this.sentSec += f.byteLength / (this.fmtSampleRate * 2);
          }
          if (this.turnState === "sealing") this.turnEndSec = this.sentSec; // весь буфер = этот ход
        } else {
          // H14 (ревью 2026-07-02): reconnect В ПРОСТОЕ (сеть моргнула МЕЖДУ ходами, напр. 1006).
          // Таймлайн нового сокета у Deepgram тоже начинается с 0, а sentSec хранил секунды СТАРОГО
          // сокета → следующий beginTurn ставил turnStartSec = стейл-значение, и гейт
          // «rStart < turnStartSec» дропал ВСЕ Results нового сокета: каждый ход — пустой финал
          // («РЕЧЬ ПОТЕРЯНА») до 120с полной тишины (idle-sleep). Свежий сокет → счёт с нуля.
          this.sentSec = 0;
          this.processedSec = 0;
          this.turnStartSec = 0;
        }
        this.openResolve?.();
        this.openResolve = null;
        this.armKeepAlive();
      });
      this.ws.addEventListener("message", (ev) => this.onMessage(ev));
      this.ws.addEventListener("error", () => log.warn("deepgram ws error (персист — переподключусь, если уместно)"));
      this.ws.addEventListener("close", (ev) => {
        log.info("deepgram WS закрыт (персист)", { code: ev?.code, reason: String(ev?.reason ?? "").slice(0, 80), msgs: this.msgCount });
        this.open = false;
        this.clearKeepAlive();
        if (!this.disposed && this.shouldReconnect(ev?.code)) {
          this.scheduleReconnect(); // committed/buffer СОХРАНЕНЫ → финал хода не теряем
          return;
        }
        this.socketDied();
      });
    } catch (e) {
      if (!this.disposed && this.shouldReconnect()) this.scheduleReconnect();
      else this.socketDied();
      void e;
    }
  }

  private onMessage(ev: WsEvent): void {
    const data = typeof ev.data === "string" ? ev.data : ev.message;
    this.msgCount += 1;
    let m: {
      type?: string;
      is_final?: boolean;
      speech_final?: boolean; // §Волна2 (2.6): endpointing=300 Deepgram — «фраза кончилась»
      start?: number;
      duration?: number;
      channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
    };
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (this.msgCount <= 5) log.info("deepgram сообщение (персист)", { n: this.msgCount, type: m?.type, raw: String(data).slice(0, 160) });
    const type = m?.type;
    if (type === "Metadata" || type === "Finalized") {
      if (this.turnState === "sealing") this.sealNow(); // Deepgram подтвердил дослку — печатаем сразу
      return;
    }
    if (type === "UtteranceEnd" || type === "SpeechStarted") return; // нет alternatives — не трогаем
    if (this.activeTurn < 0) return; // между ходами/запечатано — поздний хвост прошлого хода, ДРОП

    const rStart = Number(m.start ?? 0);
    const rEnd = rStart + Number(m.duration ?? 0);
    // ГРАНИЦА ХОДА ПО АУДИО: результат, чьё аудио НАЧАЛОСЬ до старта этого хода — хвост ПРЕДЫДУЩЕГО хода
    // (Deepgram дослал его в общий таймлайн позже). ДРОП → не протечёт в текущий ход. Это и есть фикс
    // кросс-ход утечки, независимый от лага сети/таймеров. Узкий допуск (0.05) — чтобы не дропнуть первое
    // слово СВОЕГО хода.
    if (Number.isFinite(rStart) && rStart < this.turnStartSec - 0.05) return;
    if (Number.isFinite(rEnd)) this.processedSec = Math.max(this.processedSec, rEnd);

    const text = (m?.channel?.alternatives?.[0]?.transcript ?? "").trim();
    if (text) {
      if (m.is_final) {
        this.committed = this.committed ? `${this.committed} ${text}` : text;
        this.lastInterim = "";
      } else {
        this.lastInterim = text;
      }
      const live = [this.committed, this.lastInterim].filter(Boolean).join(" ").trim();
      // Волна 1: confidence больше НЕ выбрасывается (legacy-путь его отдавал, персистентный — нет):
      // потребители (гейт обрывков/будущий clarify по неуверенности) видят уверенность Deepgram.
      const confidence = m?.channel?.alternatives?.[0]?.confidence;
      // §Волна2 (2.6): speech_final (endpointing=300) больше НЕ выбрасывается — пайплайн по нему
      // делает РАННИЙ серверный эндпоинт (~350-400мс от конца речи против ~520+150 клиентского пути).
      // Прошёл гейт границы хода выше (rStart≥turnStartSec) → хвост прошлого хода новый не эндпоинтит.
      const speechFinal = m.is_final === true && m.speech_final === true && this.turnState === "active";
      if (live)
        this.currentLease?.emitPartial({
          text: live,
          final: false,
          ...(typeof confidence === "number" ? { confidence } : {}),
          ...(speechFinal ? { speechFinal: true } : {}),
        });
    }
    // ПЕЧАТЬ, когда Deepgram обработал ВСЮ длительность хода (надёжнее таймера тишины — не зависит от
    // лага). Не дотянул — пинаем фолбэк-таймер тишины (на случай, если хвост хода был тишиной без Results).
    if (this.turnState === "sealing") {
      if (this.processedSec >= this.turnEndSec - 0.1) this.sealNow();
      else this.bumpSealQuiet();
    }
  }

  private socketDied(): void {
    this.sealNow();
    this.open = false;
    this.ws = null;
    this.reconnectAttempts = 0; // следующий beginTurn сможет реконнектить заново
    this.clearKeepAlive();
    if (this.activeTurn >= 0 && this.currentLease) this.currentLease.notifyClose(); // пайплайн переоткроет
    this.activeTurn = -1;
    this.turnState = "idle";
    this.currentLease = null;
  }

  private shouldReconnect(code?: number): boolean {
    if (this.reconnectAttempts >= MAX_RECONNECTS) return false;
    if (code === 1000) return false;
    if (code === 1008 || code === 4001 || code === 4003 || code === 4008) return false;
    return true;
  }
  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(2000, 200 * 2 ** (this.reconnectAttempts - 1));
    log.warn("deepgram: переподключение персист-стрима", { attempt: this.reconnectAttempts, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) this.connect();
    }, delay);
    if (typeof this.reconnectTimer === "object" && "unref" in this.reconnectTimer) this.reconnectTimer.unref?.();
  }
  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private armKeepAlive(): void {
    this.clearKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.disposed || !this.open || !this.ws) return;
      if (this.turnState !== "idle") return; // не во время хода/sealing
      if (Date.now() - this.lastAudioAt < 5000) return;
      try {
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
      } catch {
        /* сокет умер — close-листенер уберёт таймер */
      }
    }, 4000);
    if (typeof this.keepAliveTimer === "object" && "unref" in this.keepAliveTimer) this.keepAliveTimer.unref?.();
  }
  private clearKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private armIdleSleep(): void {
    this.clearIdleSleep();
    this.idleSleepTimer = setTimeout(() => {
      if (this.activeTurn < 0 && this.open && this.ws) {
        log.info("deepgram: усыпляю персист-сокет по простою (откроется на следующей речи)");
        try {
          this.ws.close(1000);
        } catch {
          /* уже мёртв */
        }
      }
    }, IDLE_SLEEP_MS);
    if (typeof this.idleSleepTimer === "object" && "unref" in this.idleSleepTimer) this.idleSleepTimer.unref?.();
  }
  private clearIdleSleep(): void {
    if (this.idleSleepTimer) {
      clearTimeout(this.idleSleepTimer);
      this.idleSleepTimer = null;
    }
  }

  private waitForOpen(ms: number): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.openResolve = null;
        resolve();
      }, ms);
      if (typeof t === "object" && "unref" in t) t.unref?.();
      this.openResolve = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearKeepAlive();
    this.clearReconnect();
    this.clearIdleSleep();
    this.sealNow();
    try {
      this.ws?.close(1000);
    } catch {
      /* уже мёртв */
    }
    this.ws = null;
    this.open = false;
    this.currentLease = null;
    this.activeTurn = -1;
  }
}

export class DeepgramSttProvider implements ISttProvider {
  readonly live: boolean;
  private conn: PersistentDeepgramConnection | null = null;
  /** §10: персистентный сокет вместо per-utterance churn. ДЕФОЛТ ON — изоляция ходов (нет склейки/
   * утечки хвоста) проверена тестами; per-utterance churn терял ~половину речи. JARVIS_DEEPGRAM_PERSISTENT=0 откатывает. */
  private readonly persistent = process.env.JARVIS_DEEPGRAM_PERSISTENT !== "0";

  constructor(private readonly apiKey: string | undefined) {
    this.live = Boolean(apiKey) && getWebSocket() !== undefined;
    if (!apiKey) log.warn("DEEPGRAM_API_KEY не задан — STT в mock-режиме");
    else if (getWebSocket() === undefined) log.warn("глобальный WebSocket недоступен — STT в mock-режиме");
    else if (this.persistent) log.info("Deepgram STT: ПЕРСИСТЕНТНЫЙ WS включён (JARVIS_DEEPGRAM_PERSISTENT=1)");
  }

  open(opts: SttOpts): SttStream {
    const WS = getWebSocket();
    if (!this.apiKey || !WS) return new MockSttStream();
    if (!this.persistent) return new DeepgramSttStream(this.apiKey, opts, WS); // СТАРЫЙ путь (per-utterance)
    if (!this.conn || this.conn.isDisposed() || !this.conn.sameFormat(opts)) {
      this.conn?.dispose();
      this.conn = new PersistentDeepgramConnection(this.apiKey, opts, WS);
    }
    return this.conn.beginTurn(opts);
  }

  /** Закрыть персистентный сокет (teardown сервера). Для per-utterance — no-op. */
  dispose(): void {
    this.conn?.dispose();
    this.conn = null;
  }
}

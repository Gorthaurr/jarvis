/**
 * TTS ElevenLabs через HTTP (§10, §21) — целый mp3 за один запрос.
 *
 * WS stream-input оказался ненадёжен (капризная авторизация/формат — голос мог
 * не звучать вовсе). HTTP-эндпоинт /v1/text-to-speech возвращает полный mp3 одним
 * ответом — клиент проигрывает его нативным <audio> целиком, без склейки чанков.
 * Нормализация произношения — на стороне ElevenLabs (§21). Без ключа/voiceId — Mock.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import {
  type ITtsProvider,
  MockTtsStream,
  type TtsChunk,
  type TtsOpts,
  type TtsStream,
} from "./voice-providers.js";

const log: Logger = createLogger("tts:elevenlabs");

export interface ElevenLabsConfig {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
}

// КАЧЕСТВО vs ЛАТЕНТНОСТЬ (подтверждено офиц. доками ElevenLabs, 2026):
//   flash_v2_5 / turbo_v2_5 — latency-модели (~75мс), но «плоский»/роботизированный звук,
//     особенно на русском (хуже просодия, слабее нормализация чисел). turbo — deprecated.
//   multilingual_v2 — самая натуральная/эмоциональная (рек. для нарратива/аудиокниг),
//     отличный русский, латентность ~1-2с. Для размеренного дворецкого это правильный
//     выбор: лёгкая задержка окупается живым голосом. v3 ещё выразительнее, но не для
//     real-time (высокая задержка, иная система стабильности) — держим как опцию.
// Переопределяется ELEVENLABS_MODEL.
const DEFAULT_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

/** Прочитать float из env в [min,max] с фоллбэком (для тюнинга голоса без правок кода). */
function envFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * voice_settings под размеренного дворецкого (подтверждено доками ElevenLabs):
 *   stability 0.6 — ровный предсказуемый тон (0.5 на flash «гулял» → ощущение брака);
 *   similarity_boost 0.8 — узнаваемо, но без артефактов исходного сэмпла (0.85 — у предела);
 *   style 0.0 — КЛЮЧ для дворецкого: style добавляет «игру»/нестабильность + латентность;
 *   use_speaker_boost true — чёткость; speed 0.95 — лёгкая размеренность без искажений.
 * Все четыре крутятся через ELEVENLABS_* env без перекомпиляции.
 */
const VOICE_SETTINGS = {
  stability: envFloat("ELEVENLABS_STABILITY", 0.6, 0, 1),
  similarity_boost: envFloat("ELEVENLABS_SIMILARITY", 0.8, 0, 1),
  style: envFloat("ELEVENLABS_STYLE", 0.0, 0, 1),
  use_speaker_boost: (process.env.ELEVENLABS_SPEAKER_BOOST ?? "true") !== "false",
  speed: envFloat("ELEVENLABS_SPEED", 0.95, 0.7, 1.2),
};

/** Поток TTS поверх HTTP: один запрос → полный mp3 → один чанк (last=true). */
class ElevenLabsHttpStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private errorCb?: (e: Error) => void;
  private doneCb?: () => void;
  private _cancelled = false;
  private done = false;
  private readonly controller = new AbortController();
  /** Жёсткий таймаут синтеза: без него зависший fetch держит пайплайн в thinking навсегда. */
  private readonly timeoutMs = 8_000;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    text: string,
    cfg: Required<Pick<ElevenLabsConfig, "apiKey" | "voiceId">> & ElevenLabsConfig,
    private readonly settings: typeof VOICE_SETTINGS = VOICE_SETTINGS,
  ) {
    void this.run(text, cfg);
  }

  private async run(
    text: string,
    cfg: Required<Pick<ElevenLabsConfig, "apiKey" | "voiceId">> & ElevenLabsConfig,
  ): Promise<void> {
    // Армируем таймаут: при зависании сети abort'им fetch и отдаём ошибку наверх,
    // чтобы reducer вывел пайплайн из thinking (а не молчал бесконечно).
    this.timer = setTimeout(() => {
      if (!this.done && !this._cancelled) {
        try {
          this.controller.abort();
        } catch {
          /* уже завершён */
        }
      }
    }, this.timeoutMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref?.();
    try {
      const model = cfg.modelId ?? DEFAULT_MODEL;
      const url =
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}` +
        `?output_format=mp3_44100_128`;
      const resp = await fetch(url, {
        method: "POST",
        signal: this.controller.signal,
        headers: {
          "xi-api-key": cfg.apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: this.settings,
          // Текст УЖЕ нормализован детерминированно по-русски (числа→слова, чистка markdown).
          // off отключает нормализацию ElevenLabs: на русском её встроенная логика читает
          // числа по английским правилам, плюс на flash/turbo вне Enterprise она и так не
          // работает. Явный off = детерминированно + чуть ниже латентность (§21).
          apply_text_normalization: "off",
        }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${detail.slice(0, 140)}`);
      }
      const audio = await resp.arrayBuffer();
      if (this._cancelled) return;
      log.info("TTS синтез готов", { bytes: audio.byteLength });
      this.chunkCb?.({ audio, seq: 0, last: true });
      this.finish();
    } catch (e) {
      if (this._cancelled) return;
      log.warn("TTS ошибка", e instanceof Error ? e.message : String(e));
      this.errorCb?.(e instanceof Error ? e : new Error(String(e)));
      this.finish();
    }
  }

  private finish(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.done || this._cancelled) return;
    this.done = true;
    this.doneCb?.();
  }

  onChunk(cb: (c: TtsChunk) => void): void {
    this.chunkCb = cb;
  }
  onError(cb: (e: Error) => void): void {
    this.errorCb = cb;
  }
  onDone(cb: () => void): void {
    this.doneCb = cb;
  }
  cancel(): void {
    this._cancelled = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      this.controller.abort();
    } catch {
      /* уже завершён */
    }
  }
  get cancelled(): boolean {
    return this._cancelled;
  }
}

export class ElevenLabsTtsProvider implements ITtsProvider {
  readonly live: boolean;
  constructor(private readonly cfg: ElevenLabsConfig) {
    this.live = Boolean(cfg.apiKey && cfg.voiceId);
    if (!this.live) log.warn("ElevenLabs не сконфигурирован (ключ/voiceId) — TTS в mock-режиме");
  }

  synthesize(text: string, opts?: TtsOpts): TtsStream {
    const voiceId = opts?.voiceId ?? this.cfg.voiceId;
    if (!this.cfg.apiKey || !voiceId) return new MockTtsStream(text);
    // Подмешиваем подстройку режима-маски (§11) к базовым voice_settings, клампим в допустимое.
    const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
    const settings = {
      ...VOICE_SETTINGS,
      ...(opts?.stability !== undefined ? { stability: clamp(opts.stability, 0, 1) } : {}),
      ...(opts?.style !== undefined ? { style: clamp(opts.style, 0, 1) } : {}),
      ...(opts?.speed !== undefined ? { speed: clamp(opts.speed, 0.7, 1.2) } : {}),
    };
    return new ElevenLabsHttpStream(text, { ...this.cfg, apiKey: this.cfg.apiKey, voiceId }, settings);
  }
}

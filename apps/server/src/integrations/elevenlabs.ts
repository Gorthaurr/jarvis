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
  adaptiveSpeed,
  isV3Model,
  sanitizeV3Tags,
  stripAudioTags,
} from "./voice-providers.js";
import { type Emotion, elevenStabilityFor, elevenV3Tag } from "./tts-emotion.js";

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

// ГИБРИД скорость/качество (§10): короткие реплики-подтверждения («Готово», «Я здесь, сэр») —
// на БЫСТРОЙ модели (мгновенный звук, эмоция там не нужна); содержательные ответы — на rich
// (DEFAULT_MODEL, напр. eleven_v3 с интонацией). Так простые реакции не тормозят на тяжёлой модели.
const FAST_MODEL = process.env.ELEVENLABS_MODEL_FAST || "eleven_flash_v2_5";
/** Реплики ≤ стольких символов и без интонац-тегов уходят на FAST_MODEL. 0 = гибрид выключен. */
const FAST_MAX_CHARS = (() => {
  const n = Number.parseInt(process.env.ELEVENLABS_FAST_MAX_CHARS ?? "", 10);
  return Number.isFinite(n) ? Math.max(0, n) : 64;
})();
const AUDIO_TAG_TEST = /\[[a-z][a-z ]{1,30}\]/u;

/**
 * Выбор модели под реплику (гибрид): короткий ack без интонац-тега → быстрая модель; иначе rich.
 * Наличие тега = осознанная эмоция → всегда rich (быстрая модель теги не понимает). Чистая функция.
 */
export function selectTtsModel(
  text: string,
  richModel: string,
  fastModel: string,
  maxChars: number,
): string {
  const t = text.trim();
  if (maxChars > 0 && t.length <= maxChars && !AUDIO_TAG_TEST.test(t)) return fastModel;
  return richModel;
}

/** Прочитать float из env в [min,max] с фоллбэком (для тюнинга голоса без правок кода). */
function envFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * voice_settings под ЖИВОГО дворецкого (калибровка по ресёрчу ElevenLabs 2026).
 *   stability 0.40 — на multilingual_v2 высокая стабильность (0.6) = МОНОТОННОСТЬ (сужает
 *     эмоц. диапазон → «диктор-автомат»). 0.30–0.45 = живая просодия/микро-интонация без
 *     «гуляния». Прежние 0.6 были защитой от нестабильности flash — на v2 читались плоско.
 *   similarity_boost 0.8 — узнаваемо, без артефактов сэмпла.
 *   style 0.10 — лёгкая теплота/характер; ≤0.2 безопасно, выше — дестабилизация + латентность.
 *   use_speaker_boost true — чёткость; speed 0.95 — размеренность без искажений.
 * Генерация стохастична: при артефактах поднимать stability на +0.05, потом гасить style.
 * Все крутятся через ELEVENLABS_* env без перекомпиляции; режимы §11 (modes.ts) слоятся поверх.
 */
const VOICE_SETTINGS = {
  stability: envFloat("ELEVENLABS_STABILITY", 0.4, 0, 1),
  similarity_boost: envFloat("ELEVENLABS_SIMILARITY", 0.8, 0, 1),
  style: envFloat("ELEVENLABS_STYLE", 0.1, 0, 1),
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
      // Аудио-теги интонации [warmly]/… понимает ТОЛЬКО v3 — там оставляем валидные (чистим мусорные
      // скобки), на остальных моделях вырезаем целиком (иначе прочитались бы вслух буквально).
      const finalText = isV3Model(model) ? sanitizeV3Tags(text) : stripAudioTags(text);
      // На длинной фразе чуть поджимаем темп (запрос Антона); короткую не трогаем. Кламп под
      // допустимый диапазон ElevenLabs (0.7–1.2). Длину меряем по реально звучащему тексту.
      const speed = Math.min(1.2, Math.max(0.7, adaptiveSpeed(finalText, this.settings.speed ?? 1)));
      const settings = { ...this.settings, speed };
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
          text: finalText,
          model_id: model,
          voice_settings: settings,
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
      log.info("TTS синтез готов", { bytes: audio.byteLength, model });
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
    // §21 эмоция: v3 несёт эмоцию аудио-тегом + более «творческой» (низкой) стабильностью. Тег
    // ставим в начало, если фраза ещё не помечена (LLM мог поставить свой). neutral — без изменений.
    const emotion = opts?.emotion as Emotion | undefined;
    let outText = text;
    if (emotion && emotion !== "neutral") {
      const tag = elevenV3Tag(emotion);
      if (tag && !text.trimStart().startsWith("[")) outText = `${tag} ${text}`;
      settings.stability = elevenStabilityFor(emotion, settings.stability);
    }
    // Гибрид: модель подбираем под реплику (короткий ack → быстрая, иначе rich). Явный cfg.modelId — override.
    const modelId = this.cfg.modelId ?? selectTtsModel(outText, DEFAULT_MODEL, FAST_MODEL, FAST_MAX_CHARS);
    return new ElevenLabsHttpStream(outText, { ...this.cfg, apiKey: this.cfg.apiKey, voiceId, modelId }, settings);
  }
}

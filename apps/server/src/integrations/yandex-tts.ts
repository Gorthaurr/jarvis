/**
 * TTS Yandex SpeechKit через HTTP v1 (§10, §21) — русско-нативный движок.
 *
 * Зачем: ElevenLabs (не русско-нативный) угадывает ударения и промахивается. Yandex обучен
 * на русском → ставит ударения/омографы и интонацию правильно из коробки, без словарей.
 * Эндпоинт /speech/v1/tts:synthesize отдаёт ПОЛНЫЙ mp3 одним ответом (как ElevenLabs HTTP),
 * клиент проигрывает его нативным <audio>. v3 gRPC-стриминг — апгрейд позже ради латентности.
 *
 * Авторизация: API-ключ сервисного аккаунта (роль ai.speechkit-tts.user), заголовок
 * `Authorization: Api-Key <secret>`. Без ключа — Mock. Текст уже вербализован (числа→слова).
 * Аудио-теги интонации ElevenLabs ([warmly]) Yandex не понимает → срезаем (stripAudioTags).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import {
  type ITtsProvider,
  MockTtsStream,
  type TtsChunk,
  type TtsOpts,
  type TtsStream,
  adaptiveSpeed,
  stripAudioTags,
} from "./voice-providers.js";
import { type Emotion, yandexEmotionParam } from "./tts-emotion.js";

const log: Logger = createLogger("tts:yandex");

export interface YandexTtsConfig {
  apiKey?: string;
  /** Каталог Yandex Cloud (b1g…). Опционален при API-ключе SA, но шлём для надёжности. */
  folderId?: string;
  /** Голос (filipp/ermil/zahar/alena/…). Дефолт — env YANDEX_VOICE или filipp. */
  voiceId?: string;
}

const SYNTH_URL = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize";
const DEFAULT_VOICE = process.env.YANDEX_VOICE || "filipp";

/**
 * Смягчить «паузные» знаки под Yandex (§21). Наш humanizer (для ElevenLabs) ставит тире «—» и
 * многоточия «…» как тонкие просодические подсказки — но Yandex читает их как ДЛИННЫЕ паузы
 * между словами («рваная» речь). Тире/многоточие/точку-с-запятой → запятая (короткая пауза);
 * точки и запятые оставляем (естественный ритм предложений). Только для Yandex, ElevenLabs не трогаем.
 */
export function tameYandexPunctuation(s: string): string {
  // §21 ТОЧКА → запятая (по умолчанию): Yandex на точке делает ДОЛГУЮ паузу между предложениями
  // → речь «рваная» (жалоба Антона). Точка конца предложения → запятая = короткая пауза, речь
  // течёт. Десятичную точку verbalize уже убрал (числа→слова); ?! оставляем (несут интонацию).
  // Откат к точкам: env YANDEX_KEEP_PERIODS=1.
  const softPeriods = process.env.YANDEX_KEEP_PERIODS !== "1";
  let out = s
    .replace(/\s*[—–]+\s*/gu, ", ") // тире → запятая (короткая пауза вместо длинной)
    .replace(/\s*…\s*/gu, ", ") // многоточие → запятая
    .replace(/\s*;\s*/gu, ", "); // точка с запятой → запятая
  if (softPeriods) out = out.replace(/\.(?=\s|$)/gu, ","); // точка-конец-предложения → запятая
  return out
    .replace(/,(?:\s*,)+/gu, ",") // схлопнуть подряд идущие запятые
    .replace(/\s+([,.!?])/gu, "$1") // знак примыкает к слову
    .replace(/([,.!?])(?=\S)/gu, "$1 ") // но после знака — пробел
    .replace(/[\s,]+$/u, "") // хвост фразы без висящей запятой/пробела (чтобы не тянул паузу)
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

/** Темп речи Yandex (0.1–3.0, дефолт 1.0). Тюнинг без перекомпиляции. */
function envSpeed(): number {
  const n = Number.parseFloat(process.env.YANDEX_SPEED ?? "");
  return Number.isFinite(n) ? Math.min(3, Math.max(0.1, n)) : 1.0;
}

/** Поток TTS поверх HTTP: один запрос → полный mp3 → один чанк (last=true). */
class YandexHttpStream implements TtsStream {
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
    cfg: Required<Pick<YandexTtsConfig, "apiKey">> & YandexTtsConfig,
    voice: string,
    speed: number,
    /** Уже разрешённая (валидная для голоса) роль Yandex или undefined — без эмоции. */
    private readonly emotionRole: string | undefined,
  ) {
    void this.run(text, cfg, voice, speed);
  }

  private async run(
    text: string,
    cfg: Required<Pick<YandexTtsConfig, "apiKey">> & YandexTtsConfig,
    voice: string,
    speed: number,
  ): Promise<void> {
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
      // Срезаем аудио-теги ElevenLabs (Yandex их не понимает) + смягчаем «паузные» знаки
      // (тире/многоточие → запятая), иначе Yandex делает слишком длинные паузы между словами.
      const clean = tameYandexPunctuation(stripAudioTags(text));
      // На длинной фразе чуть поджимаем темп (запрос Антона); короткую не трогаем. Длину меряем
      // по уже очищенному тексту — как реально звучит. Кламп под диапазон Yandex (0.1–3.0).
      const spoken = Math.min(3, Math.max(0.1, adaptiveSpeed(clean, speed)));
      const body = new URLSearchParams({
        text: clean,
        lang: "ru-RU",
        voice,
        format: "mp3",
        speed: String(spoken),
      });
      // §21 эмоция: роль уже разрешена под КОНКРЕТНЫЙ голос (yandexEmotionParam, 400-безопасно) —
      // приоритет у пер-реплику запрошенной эмоции, иначе env YANDEX_EMOTION (если голос её знает).
      // Каталог ролей проверен эмпирически: эмоцию умеют не все голоса (см. tts-emotion.ts).
      if (this.emotionRole) body.set("emotion", this.emotionRole);
      if (cfg.folderId) body.set("folderId", cfg.folderId);
      const resp = await fetch(SYNTH_URL, {
        method: "POST",
        signal: this.controller.signal,
        headers: {
          Authorization: `Api-Key ${cfg.apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${detail.slice(0, 160)}`);
      }
      const audio = await resp.arrayBuffer();
      if (this._cancelled) return;
      log.info("TTS синтез готов", { bytes: audio.byteLength, voice });
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

export class YandexTtsProvider implements ITtsProvider {
  readonly live: boolean;
  constructor(private readonly cfg: YandexTtsConfig) {
    this.live = Boolean(cfg.apiKey);
    if (!this.live) log.warn("Yandex SpeechKit не сконфигурирован (нет API-ключа) — TTS в mock-режиме");
  }

  synthesize(text: string, opts?: TtsOpts): TtsStream {
    if (!this.cfg.apiKey) return new MockTtsStream(text);
    // voiceId из режима-маски (§11) — это ИД голоса ElevenLabs (заглавные/цифры), Yandex его не
    // поймёт. Честим только яндексовое имя (filipp/ermil/…), иначе — наш настроенный голос.
    const req = opts?.voiceId;
    const voice = req && /^[a-z_]{3,20}$/.test(req) ? req : (this.cfg.voiceId ?? DEFAULT_VOICE);
    // Режим-маска может сдвинуть темп; stability/style у Yandex нет — игнорируем.
    const speed = opts?.speed !== undefined ? Math.min(3, Math.max(0.1, opts.speed)) : envSpeed();
    // Эмоция: пер-реплику запрошенная (opts.emotion) → роль голоса; иначе env. Разрешаем ПОД
    // конкретный голос (умеет ли он эту роль) — иначе не шлём (нейтрально, без HTTP 400).
    const emotionRole = yandexEmotionParam(voice, opts?.emotion as Emotion | undefined, process.env.YANDEX_EMOTION);
    return new YandexHttpStream(text, { ...this.cfg, apiKey: this.cfg.apiKey }, voice, speed, emotionRole);
  }
}

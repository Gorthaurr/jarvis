/**
 * Стриминговые контракты STT/TTS (§10) — общий шов голосового пайплайна.
 *
 * STT и TTS — строго за интерфейсами (§1, §12): RU-качество Deepgram — bake-off,
 * провайдер заменяем (Gladia/Soniox/Yandex) без правок пайплайна. Реальные клиенты
 * (deepgram.ts/elevenlabs.ts) и Mock-реализации (здесь) имплементируют эти типы.
 *
 * Принцип латентности (§10): НИКОГДА не ждать полный результат — стримим частичные
 * транскрипты и первый аудио-чанк TTS после первого предложения.
 */
import type { Emotion } from "./tts-emotion.js";

// ── STT (streaming) ──────────────────────────────────────────

/** Частичная/финальная гипотеза распознавания. */
export interface SttPartial {
  text: string;
  /** true — фраза финализирована STT (endpoint), false — промежуточный (interim). */
  final: boolean;
  /** Уверенность 0..1, если провайдер отдаёт. */
  confidence?: number;
  /**
   * §Волна2 (2.6): провайдер сам зафиксировал КОНЕЦ ФРАЗЫ (Deepgram speech_final: речь + ~300мс
   * тишины по его VAD) — сигнал раннего серверного эндпоинта (быстрее клиентской цепочки
   * hangover+minSilence ~520мс). Провайдеры без сигнала поле не ставят (поведение как раньше).
   */
  speechFinal?: boolean;
}

export interface SttOpts {
  sampleRate: number;
  /** BCP-47, напр. "ru". */
  language?: string;
  /** Запрашивать промежуточные результаты (ранний старт LLM, §10). */
  interimResults?: boolean;
}

/**
 * Живой STT-стрим. Аудио пушится кадрами; гипотезы приходят колбэком.
 * close() финализирует и дожидается последнего final.
 */
export interface SttStream {
  /** Подать кадр PCM (16-bit LE mono обычно). */
  pushAudio(pcm: ArrayBuffer): void;
  onPartial(cb: (p: SttPartial) => void): void;
  onError(cb: (e: Error) => void): void;
  onClose(cb: () => void): void;
  /** Завершить ввод аудио и закрыть стрим. */
  close(): Promise<void>;
  /** true — реальный провайдер; false — mock/стаб. */
  readonly live: boolean;
}

export interface ISttProvider {
  /** Есть ли реальный ключ (иначе open() вернёт mock-стрим). */
  readonly live: boolean;
  /** Открыть новый стрим распознавания. */
  open(opts: SttOpts): SttStream;
  /** Освободить ресурсы (персистентный сокет) на teardown сервера. Необязателен. */
  dispose?(): void;
}

// ── TTS (streaming) ──────────────────────────────────────────

/** Аудио-чанк синтеза (для speak.chunk, §5). */
export interface TtsChunk {
  audio: ArrayBuffer;
  seq: number;
  last: boolean;
}

export interface TtsOpts {
  voiceId?: string;
  sampleRate?: number;
  /**
   * Тонкая подстройка голоса под режим-маску (§11): сдвигает ПОДАЧУ на том же голосе.
   * stability/style 0..1, speed ~0.7..1.2 (ElevenLabs voice_settings). undefined → дефолт.
   */
  stability?: number;
  style?: number;
  speed?: number;
  /**
   * Семантическая ЭМОЦИЯ подачи (§21): провайдеро-независимая (happy/angry/strict/whisper/neutral).
   * Каждый TTS-провайдер сам отображает её на свои возможности (Yandex — роль голоса, ElevenLabs v3 —
   * аудио-тег). См. integrations/tts-emotion.ts. undefined → без эмоции (нейтрально/как настроено).
   */
  emotion?: Emotion;
}

/**
 * Живой TTS-стрим. Чанки приходят колбэком; cancel() — для barge-in (§10):
 * пользователь заговорил → рубим синтез немедленно.
 */
export interface TtsStream {
  onChunk(cb: (c: TtsChunk) => void): void;
  onError(cb: (e: Error) => void): void;
  onDone(cb: () => void): void;
  /** Прервать синтез/воспроизведение (barge-in, §10). */
  cancel(): void;
  readonly cancelled: boolean;
}

export interface ITtsProvider {
  readonly live: boolean;
  /** Начать синтез текста; чанки стримятся по мере готовности. */
  synthesize(text: string, opts?: TtsOpts): TtsStream;
}

// ── аудио-теги интонации (ElevenLabs v3, §21) ────────────────

/**
 * Аудио-теги интонации v3 в квадратных скобках: [warmly], [thoughtfully], [chuckles softly].
 * v3 их ИНТЕРПРЕТИРУЕТ (эмоция/подача); другие модели прочитали бы их вслух, а в тексте-дисплее
 * они мусор — поэтому вырезаем везде, КРОМЕ TTS-пути на v3.
 */
const AUDIO_TAG_RE = /\[[^\]\n]{1,40}\]/gu;
/** Валидный v3-тег — только английские слова в скобках ([warmly]), не «[1]»/«[см.]». */
const V3_TAG_OK = /^\[[a-z][a-z ]{1,30}\]$/u;

/** Убрать ВСЕ аудио-теги (для дисплея и моделей кроме v3). */
export function stripAudioTags(s: string): string {
  return s
    .replace(AUDIO_TAG_RE, "")
    .replace(/\s+([,.!?…;:])/gu, "$1")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

/** Оставить только валидные английские v3-теги, мусорные скобки убрать (защита на v3-пути). */
export function sanitizeV3Tags(s: string): string {
  return s
    .replace(AUDIO_TAG_RE, (m) => (V3_TAG_OK.test(m) ? m : ""))
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

/** Поддерживает ли модель аудио-теги интонации (семейство eleven_v3). */
export function isV3Model(modelId: string | undefined): boolean {
  return (modelId ?? "").toLowerCase().startsWith("eleven_v3");
}

// ── адаптивная скорость речи для длинных фраз (§10/§21) ───────

/**
 * Запрос Антона: «немного ускорять речь, если фраза длинная». Долгий ответ дворецкого на штатном
 * темпе тянется и утомляет — на длинной фразе чуть поджимаем темп, на короткой не трогаем.
 * Параметры — общие для ВСЕХ TTS-провайдеров (Yandex/ElevenLabs), единый источник правды (DRY).
 */
export interface SpeedupConfig {
  /** Включена ли адаптация (JARVIS_TTS_SPEEDUP=0 → выкл, темп = base всегда). */
  enabled: boolean;
  /** Максимальный множитель темпа на самой длинной фразе (напр. 1.12 = +12%). */
  max: number;
  /** Длина (символов спикабельного текста) ≤ этой → база, ускорения нет. */
  minChars: number;
  /** Длина ≥ этой → полный множитель max; между min и full — линейно. */
  fullChars: number;
}

function envNumber(name: string, fallback: number, lo: number, hi: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** Конфиг адаптивной скорости из env (тюнинг без перекомпиляции). */
export function speedupConfigFromEnv(): SpeedupConfig {
  const minChars = envNumber("JARVIS_TTS_SPEEDUP_MIN_CHARS", 90, 0, 100_000);
  const fullChars = envNumber("JARVIS_TTS_SPEEDUP_FULL_CHARS", 280, 1, 100_000);
  return {
    enabled: (process.env.JARVIS_TTS_SPEEDUP ?? "1") !== "0",
    max: envNumber("JARVIS_TTS_SPEEDUP_MAX", 1.12, 1, 2),
    minChars,
    // full всегда строго больше min (иначе деление на ноль / ступенька)
    fullChars: Math.max(fullChars, minChars + 1),
  };
}

/**
 * Множитель темпа речи под длину фразы. Короткая (≤minChars) → base без изменений; длинная
 * (≥fullChars) → base*max; между — линейная интерполяция. Чистая функция (тестируется без сети).
 * Текст следует передавать УЖЕ очищенный от аудио-тегов/разметки (как реально звучит).
 */
export function adaptiveSpeed(
  text: string,
  base: number,
  cfg: SpeedupConfig = speedupConfigFromEnv(),
): number {
  if (!cfg.enabled || cfg.max <= 1) return base;
  const len = text.trim().length;
  if (len <= cfg.minChars) return base;
  const span = Math.max(1, cfg.fullChars - cfg.minChars);
  const t = Math.min(1, (len - cfg.minChars) / span);
  return base * (1 + (cfg.max - 1) * t);
}

// ── Mock-реализации (тесты и режим без ключей) ───────────────

/**
 * Mock STT: при close() (или при наборе достаточного аудио) выдаёт заранее
 * заданный транскрипт. Если scriptedFinal не задан — эхо «тишины».
 * Для тестов можно эмитить interim вручную через emitPartial().
 */
export class MockSttStream implements SttStream {
  readonly live = false;
  private partialCb?: (p: SttPartial) => void;
  private errorCb?: (e: Error) => void;
  private closeCb?: () => void;
  private closed = false;
  private bytes = 0;

  constructor(private readonly scriptedFinal?: string) {}

  pushAudio(pcm: ArrayBuffer): void {
    if (this.closed) return;
    this.bytes += pcm.byteLength;
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
  /** Ручная эмиссия гипотезы — для тестов. */
  emitPartial(p: SttPartial): void {
    this.partialCb?.(p);
  }
  /** Полученные байты аудио (диагностика тестов). */
  get audioBytes(): number {
    return this.bytes;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.scriptedFinal !== undefined) {
      this.partialCb?.({ text: this.scriptedFinal, final: true, confidence: 1 });
    }
    this.closeCb?.();
  }
  /** Сымитировать ошибку провайдера. */
  emitError(e: Error): void {
    this.errorCb?.(e);
  }
}

export class MockSttProvider implements ISttProvider {
  readonly live = false;
  /** Очередь финальных транскриптов: open() берёт следующий. */
  constructor(private readonly scripted: string[] = []) {}
  private idx = 0;
  open(_opts: SttOpts): MockSttStream {
    const next = this.scripted[this.idx];
    this.idx += 1;
    return new MockSttStream(next);
  }
}

/**
 * Mock TTS: разбивает текст на N чанков (по словам/длине) и эмитит их
 * синхронно-асинхронно через microtask, уважая cancel() (barge-in).
 */
export class MockTtsStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private errorCb?: (e: Error) => void;
  private doneCb?: () => void;
  private _cancelled = false;

  constructor(
    private readonly text: string,
    private readonly chunkCount = 3,
  ) {
    // Эмитим на следующем тике, чтобы подписка onChunk успела установиться.
    queueMicrotask(() => this.run());
  }

  private run(): void {
    if (this._cancelled) return;
    const n = Math.max(1, this.chunkCount);
    for (let i = 0; i < n; i += 1) {
      if (this._cancelled) return;
      const last = i === n - 1;
      // Псевдо-аудио: байты длины текста / n (детерминированно для тестов).
      const size = Math.max(1, Math.ceil(this.text.length / n));
      this.chunkCb?.({ audio: new ArrayBuffer(size), seq: i, last });
    }
    if (!this._cancelled) this.doneCb?.();
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
  }
  get cancelled(): boolean {
    return this._cancelled;
  }
  /** Сымитировать ошибку — для тестов. */
  emitError(e: Error): void {
    this.errorCb?.(e);
  }
}

export class MockTtsProvider implements ITtsProvider {
  readonly live = false;
  constructor(private readonly chunkCount = 3) {}
  synthesize(text: string, _opts?: TtsOpts): MockTtsStream {
    return new MockTtsStream(text, this.chunkCount);
  }
}

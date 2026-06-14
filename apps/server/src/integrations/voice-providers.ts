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

// ── STT (streaming) ──────────────────────────────────────────

/** Частичная/финальная гипотеза распознавания. */
export interface SttPartial {
  text: string;
  /** true — фраза финализирована STT (endpoint), false — промежуточный (interim). */
  final: boolean;
  /** Уверенность 0..1, если провайдер отдаёт. */
  confidence?: number;
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

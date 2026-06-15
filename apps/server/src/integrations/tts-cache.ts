/**
 * Кеширующий декоратор TTS (§15, §21): повторяющиеся фразы (филлеры «секунду»,
 * типовые ответы/подтверждения) не синтезируются повторно — экономия символов
 * ElevenLabs. Ключ — (voiceId, текст). На попадании проигрываем закешированные
 * чанки без вызова API; на промахе — синтезируем и собираем чанки в кеш.
 *
 * Реализует ITtsProvider (voice-providers.ts), композируется поверх любого TTS.
 */
import { type CacheStats, TtlCache } from "@jarvis/shared";
import type { ITtsProvider, TtsChunk, TtsOpts, TtsStream } from "./voice-providers.js";

/** id модели TTS включаем в ключ: смена ELEVENLABS_MODEL не должна отдавать старый голос. */
const TTS_MODEL_TAG = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

/**
 * Ключ кеша TTS. Длина-префиксы у voiceId/model исключают коллизию через двоеточие
 * (напр. пустой voiceId + текст «X:…» против voiceId «X» + текст «…»).
 */
function cacheKey(voiceId: string | undefined, text: string): string {
  const v = voiceId ?? "";
  return `${v.length}:${v}|${TTS_MODEL_TAG.length}:${TTS_MODEL_TAG}|${text}`;
}

/** Проигрыватель заранее закешированных чанков — без вызова API. */
class ReplayTtsStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private doneCb?: () => void;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: контракт TtsStream
  private errorCb?: (e: Error) => void;
  private _cancelled = false;

  constructor(private readonly chunks: readonly TtsChunk[]) {
    queueMicrotask(() => this.run());
  }

  private run(): void {
    if (this._cancelled) return;
    for (const c of this.chunks) {
      if (this._cancelled) return;
      this.chunkCb?.({ audio: c.audio, seq: c.seq, last: c.last });
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
}

/** Обёртка: форвардит чанки наружу и собирает их; по успешному завершению — store(). */
class CollectingTtsStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private doneCb?: () => void;
  private errorCb?: (e: Error) => void;
  private readonly collected: TtsChunk[] = [];

  constructor(
    private readonly inner: TtsStream,
    private readonly store: (chunks: TtsChunk[]) => void,
  ) {
    inner.onChunk((c) => {
      this.collected.push(c);
      this.chunkCb?.(c);
    });
    inner.onError((e) => this.errorCb?.(e));
    inner.onDone(() => {
      // Кешируем только полный успешный синтез (не прерванный barge-in'ом).
      if (!inner.cancelled && this.collected.length > 0) this.store(this.collected.slice());
      this.doneCb?.();
    });
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
    this.inner.cancel();
  }
  get cancelled(): boolean {
    return this.inner.cancelled;
  }
}

export class CachingTtsProvider implements ITtsProvider {
  readonly live: boolean;
  private readonly cache: TtlCache<TtsChunk[]>;

  constructor(
    private readonly inner: ITtsProvider,
    opts: { ttlMs?: number; maxEntries?: number } = {},
  ) {
    this.live = inner.live;
    this.cache = new TtlCache<TtsChunk[]>({
      ttlMs: opts.ttlMs ?? 6 * 3_600_000,
      maxEntries: opts.maxEntries ?? 500,
    });
  }

  synthesize(text: string, opts?: TtsOpts): TtsStream {
    const key = cacheKey(opts?.voiceId, text);
    const cached = this.cache.get(key);
    if (cached) return new ReplayTtsStream(cached);
    return new CollectingTtsStream(this.inner.synthesize(text, opts), (chunks) =>
      this.cache.set(key, chunks),
    );
  }

  get stats(): CacheStats {
    return this.cache.stats;
  }
}

/**
 * Локальный STT через Whisper (transformers.js / ONNX) — слух Джарвиса без ключей (§10).
 *
 * Реализует ISttProvider (voice-providers.ts). Буферизует PCM 16-bit одной фразы
 * (между speech_start и speech_end в пайплайне) и на close() транскрибирует целиком —
 * utterance-based (Whisper не стримит нативно). Модель грузится лениво, один раз
 * на процесс (первый прогон скачивает ~150–250 МБ, дальше из кеша). CPU; на GPU
 * можно перейти позже (onnxruntime-node WebGPU/CUDA).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { ISttProvider, SttOpts, SttPartial, SttStream } from "./voice-providers.js";

const log: Logger = createLogger("stt:whisper");

/** Тип pipeline транскрайбера — нестрогий (SDK динамический). */
type Transcriber = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ text?: string } | { text?: string }[]>;

let transcriberPromise: Promise<Transcriber> | null = null;

/** Лениво загрузить Whisper-пайплайн (один раз на процесс). */
function getTranscriber(model: string): Promise<Transcriber> {
  if (transcriberPromise) return transcriberPromise;
  transcriberPromise = (async () => {
    const mod = (await import("@huggingface/transformers")) as unknown as {
      pipeline: (task: string, model: string, opts?: unknown) => Promise<Transcriber>;
      env: { remoteHost?: string; cacheDir?: string };
    };
    // huggingface.co часто недоступен из РФ → зеркало (или VPN). Настраивается HF_ENDPOINT.
    const endpoint = process.env.HF_ENDPOINT || "https://hf-mirror.com";
    mod.env.remoteHost = endpoint;
    log.info("Whisper: загрузка модели (первый раз — скачивание)", { model, endpoint });
    const t = await mod.pipeline("automatic-speech-recognition", model);
    log.info("Whisper: модель готова", { model });
    return t;
  })();
  return transcriberPromise;
}

/** PCM 16-bit LE → нормализованный Float32 [-1,1] для Whisper. */
function pcm16ToFloat32(u8: Uint8Array): Float32Array {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = Math.floor(u8.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** BCP-47 → имя языка Whisper (transformers.js ждёт полное имя). */
function whisperLang(code?: string): string {
  if (!code) return "russian";
  const c = code.toLowerCase();
  if (c.startsWith("ru")) return "russian";
  if (c.startsWith("en")) return "english";
  return c;
}

/** Минимум аудио для распознавания (байт). ~0.4с @16кГц 16-bit = 12800 байт. */
const MIN_BYTES = 12_800;

class WhisperSttStream implements SttStream {
  readonly live = true;
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private closed = false;
  private partialCb?: (p: SttPartial) => void;
  private errorCb?: (e: Error) => void;
  private closeCb?: () => void;

  constructor(
    private readonly model: string,
    private readonly language: string,
  ) {}

  pushAudio(pcm: ArrayBuffer): void {
    if (this.closed) return;
    this.chunks.push(new Uint8Array(pcm.slice(0)));
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.bytes < MIN_BYTES) {
        this.closeCb?.();
        return; // слишком коротко — шум/тишина
      }
      const merged = new Uint8Array(this.bytes);
      let off = 0;
      for (const c of this.chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      const audio = pcm16ToFloat32(merged);
      const t = await getTranscriber(this.model);
      const out = await t(audio, { language: this.language, task: "transcribe", chunk_length_s: 30 });
      const text = (Array.isArray(out) ? out[0]?.text : out?.text)?.trim() ?? "";
      if (text) {
        log.info("Whisper транскрипт", { text });
        this.partialCb?.({ text, final: true, confidence: 1 });
      }
    } catch (e) {
      log.warn("Whisper ошибка", e instanceof Error ? e.message : String(e));
      this.errorCb?.(e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.closeCb?.();
    }
  }
}

export class WhisperSttProvider implements ISttProvider {
  readonly live = true;
  constructor(
    private readonly model = "Xenova/whisper-base",
    private readonly defaultLanguage = "russian",
  ) {}

  open(opts: SttOpts): SttStream {
    return new WhisperSttStream(this.model, whisperLang(opts.language) || this.defaultLanguage);
  }
}

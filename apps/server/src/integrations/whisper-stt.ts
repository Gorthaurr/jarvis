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

import { getTranscriber } from "./whisper-runtime.js";
export { warmupWhisper } from "./whisper-runtime.js";
import { pcm16ToFloat32, whisperLang, normalizeAudio, isNoise, MIN_BYTES, SILENCE_PEAK } from "./whisper-audio.js";
import { transcribeUtterance } from "./whisper-once.js";

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
    private readonly logTranscript = true,
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
      log.info("whisper close", { bytes: this.bytes, sec: (this.bytes / 32000).toFixed(2) });
      if (this.bytes < MIN_BYTES) {
        log.info("whisper: дроп — слишком короткий буфер (<0.5с)", { bytes: this.bytes });
        return; // слишком коротко — шум/тишина
      }
      const merged = new Uint8Array(this.bytes);
      let off = 0;
      for (const c of this.chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      const raw = pcm16ToFloat32(merged);
      // Гейт по ПИКУ + усиление тихого микрофона (см. normalizeAudio).
      const { audio, peak } = normalizeAudio(raw);
      if (peak < SILENCE_PEAK) {
        log.info("whisper: дроп — тишина (пик ниже порога)", { peak: peak.toFixed(4), threshold: SILENCE_PEAK });
        return;
      }
      log.info("whisper: уровень ок, распознаю", { peak: peak.toFixed(4) });
      const t = await getTranscriber(this.model);
      // ИМЕННО этот набор проверен на реальной речи (turbo+cpu+q8 → идеальный транскрипт).
      // НЕ добавлять openai-whisper-пороги (temperature:0/no_speech_threshold/compression_ratio_
      // threshold/condition_on_previous_text) — transformers.js их не поддерживает и они ломают
      // генерацию («token_ids must be non-empty»). Анти-галлюцинации: RMS-гейт + denylist + модель.
      const out = await t(audio, {
        language: this.language,
        task: "transcribe",
        chunk_length_s: 30,
      });
      const text = (Array.isArray(out) ? out[0]?.text : out?.text)?.trim() ?? "";
      if (text && !isNoise(text)) {
        if (this.logTranscript) log.info("Whisper транскрипт", { text });
        this.partialCb?.({ text, final: true, confidence: 1 });
      } else {
        if (this.logTranscript) log.info("whisper: дроп — пусто/фантом", { text: text || "(пусто)" });
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

  transcribeOnce(pcm: ArrayBuffer, sampleRate: number, signal?: AbortSignal): Promise<string> {
    return transcribeUtterance({ open: () => new WhisperSttStream(this.model, this.defaultLanguage, false) }, pcm, sampleRate, signal);
  }

  open(opts: SttOpts): SttStream {
    return new WhisperSttStream(this.model, whisperLang(opts.language) || this.defaultLanguage);
  }
}

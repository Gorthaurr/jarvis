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

    // ВАЖНО (проверено на реальной речи): DirectML численно ломает whisper-large-v3-turbo
    // (fp16/q8 → словесная каша, fp32 → token_ids-краш). CPU+q8 транскрибирует ИДЕАЛЬНО
    // (~3с инференс). Так что слух идёт на CPU; ускорение — отдельным шагом (CUDA whisper.cpp).
    const device = process.env.WHISPER_DEVICE || "cpu";
    const dtype = process.env.WHISPER_DTYPE || "q8";
    log.info("Whisper: загрузка модели (первый раз — скачивание)", { model, endpoint, device, dtype });
    try {
      const t = await mod.pipeline("automatic-speech-recognition", model, { device, dtype });
      log.info("Whisper: модель готова", { model, device, dtype });
      return t;
    } catch (e) {
      // Конфиг не поднялся → честный откат на дефолтный CPU, чтобы слух не отвалился совсем.
      log.warn("Whisper: конфиг не поднялся — откат на дефолтный CPU", {
        err: e instanceof Error ? e.message : String(e),
      });
      transcriberPromise = null; // позволить повторную попытку при следующем обращении
      const t = await mod.pipeline("automatic-speech-recognition", model);
      log.info("Whisper: модель готова (CPU fallback)", { model });
      return t;
    }
  })();
  return transcriberPromise;
}

/** Прогреть модель на старте сервера — чтобы первая фраза не ждала загрузки/upload на GPU. */
export function warmupWhisper(model: string): void {
  log.info("Whisper: прогрев модели на старте", { model });
  void getTranscriber(model).catch((e) =>
    log.warn("Whisper: прогрев не удался", e instanceof Error ? e.message : String(e)),
  );
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

/** Минимум аудио для распознавания (байт). ~0.5с @16кГц 16-bit = 16000 байт. */
const MIN_BYTES = 16_000;
/** Ниже этого ПИКА амплитуды считаем тишиной/шумом (Whisper там галлюцинирует «Спасибо»,
 *  «Продолжение следует» и т.п.). Реальная речь — пик 0.1–0.6, шум/эхо — <0.06. */
const SILENCE_PEAK = 0.06;

/**
 * Нормализация громкости. КРИТИЧНО: гейт по ПИКУ, НЕ по среднему RMS — длинный буфер
 * (речь + хвост тишины) разбавлял средний RMS и реальная (особенно тихая) речь резалась
 * как «тишина». Тихий микрофон усиливаем до целевого пика, чтобы Whisper уверенно распознал.
 * Возвращает (возможно усиленный) сигнал и исходный пик амплитуды.
 */
function normalizeAudio(audio: Float32Array, targetPeak = 0.3): { audio: Float32Array; peak: number } {
  let peak = 0;
  for (let i = 0; i < audio.length; i += 1) {
    const a = Math.abs(audio[i]!);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return { audio, peak }; // практически тишина — не усиливаем
  const gain = Math.min(4, targetPeak / peak); // кап ×4 (большое усиление раздувало шум → галлюцинации)
  if (gain <= 1.05) return { audio, peak }; // уже достаточно громко
  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i += 1) out[i] = Math.max(-1, Math.min(1, audio[i]! * gain));
  return { audio: out, peak };
}

/**
 * Частые галлюцинации Whisper на тишине/шуме (обучен на ютуб-субтитрах) — дропаем,
 * иначе Джарвис «сходит с ума», отвечая на фантомные фразы.
 */
const HALLUCINATIONS: RegExp[] = [
  /субтитры?\b/i,
  /продолжение следует/i,
  /следующей серии/i,
  /смотрите продолжение/i,
  /спасибо за просмотр/i,
  /смотрите (на|в|это) видео/i,
  /подпис(ывайтесь|ка)/i,
  // ВНИМАНИЕ: НЕ добавлять сюда голые слова-подстроки вроде /редактор/ или /смешка/ —
  // они матчат ЖИВЫЕ команды («открой редактор», «текстовый редактор») и глушат речь.
  // Раньше так и было → Джарвис «не слышал» реальные просьбы. Денилист — только
  // характерные ютуб-фантомы Whisper целиком, не куски нормальных фраз.
  /^[\s.…!?,-]*$/,
  /^\(.*\)$/,
];
function isNoise(text: string): boolean {
  const s = text.trim();
  if (s.length < 2) return true;
  if (s.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return true;
  return HALLUCINATIONS.some((re) => re.test(s));
}

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
      log.info("whisper close", { bytes: this.bytes, sec: (this.bytes / 32000).toFixed(2) });
      if (this.bytes < MIN_BYTES) {
        log.info("whisper: дроп — слишком короткий буфер (<0.5с)", { bytes: this.bytes });
        this.closeCb?.();
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
        this.closeCb?.();
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
        log.info("Whisper транскрипт", { text });
        this.partialCb?.({ text, final: true, confidence: 1 });
      } else {
        log.info("whisper: дроп — пусто/фантом", { text: text || "(пусто)" });
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

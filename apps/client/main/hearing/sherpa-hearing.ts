/**
 * W1 «СЛУХ» (2026-09-09): локальный wake-word и VAD на sherpa-onnx — В ПРОЦЕССЕ Electron main.
 *
 * До W1 wake-слово матчилось ПО ТЕКСТУ облачного STT (MockWakeWord.ready=false → гейт микрофона всегда
 * открыт), а VAD был порогом RMS. Итог: весь звук комнаты стримился в Deepgram непрерывно (§0.6 нарушен
 * по построению), а телевизор в окне разговора становился командами (лог 2026-09-06).
 *
 * Теперь:
 *  • Wake — sherpa-onnx KeywordSpotter (zipformer gigaspeech 3.3M, open-vocabulary): ключевые слова —
 *    BPE-написания того, как эта английская модель «слышит» русское «Джарвис» (`jarvis-keywords.txt`:
 *    jarvis/javis/jarvice/jadavice/javas/jervis/…). Проба на 4 русских TTS-голосах + английском: 7/7
 *    срабатываний через ~150 мс после слова, 0/4 ложных (включая «джаз/джип/Джордж/Джессика»).
 *    CPU ≈ 1–2 мс на 20-мс кадр. Порог per-keyword в файле (#0.2).
 *  • VAD — Silero VAD v5 через sherpa (`silero_vad.onnx`): isDetected() → speech_start/speech_end.
 *
 * ГРАБЛИ: (1) нативный sherpa не открывает файлы по НЕ-ASCII пути (проект лежит под `…/Автокомп/…`) —
 * модели живут в `~/.jarvis/models/` (как speaker-embedding у сервера), override `JARVIS_HEARING_MODELS`;
 * (2) sherpa-onnx-node и onnxruntime-node в ОДНОМ процессе конфликтуют по onnxruntime.dll (урок сервера)
 * — поэтому на клиенте только sherpa (VAD тоже его); (3) модуль нативный → в esbuild `external`, грузим
 * динамическим import'ом по переменной; нет пакета/моделей → честный null и прежние заглушки.
 * Модели ставит `apps/client/scripts/fetch-hearing-models.mjs`.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import type { IVad, VadSignal } from "../vad/index.js";
import type { IWakeWord } from "../wakeword/index.js";

const log: Logger = createLogger("hearing");

/** Каталог моделей слуха (ASCII-путь!). */
export function hearingModelsDir(): string {
  return process.env.JARVIS_HEARING_MODELS || join(homedir(), ".jarvis", "models");
}

export const KWS_MODEL_DIR = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";

export interface HearingPaths {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  keywords: string;
  sileroVad: string;
}

export function hearingPaths(dir = hearingModelsDir()): HearingPaths {
  const k = join(dir, "kws", KWS_MODEL_DIR);
  return {
    encoder: join(k, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
    decoder: join(k, "decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
    joiner: join(k, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
    tokens: join(k, "tokens.txt"),
    keywords: process.env.JARVIS_WAKE_KEYWORDS || join(dir, "kws", "jarvis-keywords.txt"),
    sileroVad: join(dir, "silero_vad.onnx"),
  };
}

/** Все ли файлы моделей на месте (без загрузки нативного модуля). */
export function hearingModelsPresent(dir = hearingModelsDir()): boolean {
  const p = hearingPaths(dir);
  return [p.encoder, p.decoder, p.joiner, p.tokens, p.keywords, p.sileroVad].every((f) => existsSync(f));
}

/** Путь содержит не-ASCII символы — sherpa его не откроет (fopen в нативном коде). */
export function isAsciiPath(p: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(p);
}

// Минимальные типы sherpa-onnx-node, которые мы используем (пакет без .d.ts для нашего среза).
interface SherpaStream {
  acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void;
}
interface SherpaKws {
  createStream(): SherpaStream;
  isReady(s: SherpaStream): boolean;
  decode(s: SherpaStream): void;
  reset(s: SherpaStream): void;
  getResult(s: SherpaStream): { keyword?: string };
}
interface SherpaVadHandle {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  reset(): void;
}
interface SherpaModule {
  KeywordSpotter: new (cfg: Record<string, unknown>) => SherpaKws;
  Vad: new (cfg: Record<string, unknown>, bufferSizeInSeconds: number) => SherpaVadHandle;
}

/** PCM16 → float32 [-1, 1] (sherpa ждёт нормализованный float). */
export function pcm16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = (pcm[i] ?? 0) / 32768;
  return out;
}

/** Wake-слово «Джарвис» на sherpa KeywordSpotter. `process` синхронный: ~1–2 мс на кадр 20 мс. */
export class SherpaWakeWord implements IWakeWord {
  readonly ready = true;
  private stream: SherpaStream;
  /** Последнее сработавшее написание (диагностика: какое «ухо» поймало владельца). */
  lastKeyword = "";
  private readonly onDetect?: (keyword: string) => void;

  constructor(private readonly kws: SherpaKws, onDetect?: (keyword: string) => void) {
    this.stream = kws.createStream();
    this.onDetect = onDetect;
  }

  process(pcm: Int16Array): boolean {
    this.stream.acceptWaveform({ samples: pcm16ToFloat(pcm), sampleRate: 16_000 });
    let hit = false;
    while (this.kws.isReady(this.stream)) {
      this.kws.decode(this.stream);
      const r = this.kws.getResult(this.stream);
      if (r.keyword) {
        hit = true;
        this.lastKeyword = r.keyword;
        this.kws.reset(this.stream);
      }
    }
    if (hit) this.onDetect?.(this.lastKeyword);
    return hit;
  }

  /**
   * Сброс контекста (после открытия/закрытия гейта — чтобы хвост «Джарвис» не сработал повторно).
   * Пересоздаём стрим, а не kws.reset(stream): сброс декодера оставляет левый контекст энкодера
   * (64 кадра) от прошлого хода, и следующее «Джарвис» на его хвосте ловилось нестабильно (корпусный
   * тест: pos_jane после трёх файлов подряд не детектился на одном стриме, на свежем — детектится).
   */
  reset(): void {
    this.stream = this.kws.createStream();
  }
}

/** Silero VAD через sherpa: speech_start/speech_end по фронтам isDetected(). */
export class SherpaVad implements IVad {
  private _speaking = false;

  constructor(private readonly vad: SherpaVadHandle) {}

  get speaking(): boolean {
    return this._speaking;
  }

  process(pcm: Int16Array): VadSignal {
    this.vad.acceptWaveform(pcm16ToFloat(pcm));
    const now = this.vad.isDetected();
    if (now === this._speaking) return null;
    this._speaking = now;
    return now ? "speech_start" : "speech_end";
  }

  reset(): void {
    this.vad.reset();
    this._speaking = false;
  }
}

export interface SherpaHearing {
  wake: SherpaWakeWord;
  vad: SherpaVad;
  keywordsFile: string;
}

/**
 * Поднять слух. null (с честным WARN) — если нет пакета, моделей или путь не ASCII: вызывающий остаётся
 * на прежних заглушках (MockWakeWord + EnergyVad), клиент не падает.
 */
export async function createSherpaHearing(opts: { dir?: string; onWake?: (keyword: string) => void } = {}): Promise<SherpaHearing | null> {
  const dir = opts.dir ?? hearingModelsDir();
  if (!isAsciiPath(dir)) {
    log.warn("каталог моделей слуха содержит не-ASCII символы — sherpa его не откроет; задайте JARVIS_HEARING_MODELS", { dir });
    return null;
  }
  if (!hearingModelsPresent(dir)) {
    log.warn("модели слуха не найдены — wake по тексту облака и энергетический VAD (поставьте: node apps/client/scripts/fetch-hearing-models.mjs)", { dir });
    return null;
  }
  let sherpa: SherpaModule;
  try {
    const spec = "sherpa-onnx-node"; // по переменной: esbuild не бандлит нативный модуль
    sherpa = (await import(spec)) as SherpaModule;
  } catch (e) {
    log.warn("sherpa-onnx-node не загрузился — слух на заглушках", e instanceof Error ? e.message : String(e));
    return null;
  }
  const p = hearingPaths(dir);
  try {
    const t0 = Date.now();
    const kws = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: p.encoder, decoder: p.decoder, joiner: p.joiner },
        tokens: p.tokens,
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      maxActivePaths: 4,
      numTrailingBlanks: 1,
      keywordsScore: 2.0,
      keywordsThreshold: 0.2, // per-keyword порог в файле главнее
      keywordsFile: p.keywords,
    });
    const vad = new sherpa.Vad(
      {
        sileroVad: { model: p.sileroVad, threshold: 0.5, minSilenceDuration: 0.25, minSpeechDuration: 0.1, windowSize: 512, maxSpeechDuration: 20 },
        sampleRate: 16_000,
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      30,
    );
    log.info("слух поднят: локальный wake «Джарвис» (sherpa KWS) + Silero VAD", { ms: Date.now() - t0, keywords: p.keywords });
    return { wake: new SherpaWakeWord(kws, opts.onWake), vad: new SherpaVad(vad), keywordsFile: p.keywords };
  } catch (e) {
    log.warn("слух не поднялся (sherpa) — заглушки", e instanceof Error ? e.message : String(e));
    return null;
  }
}

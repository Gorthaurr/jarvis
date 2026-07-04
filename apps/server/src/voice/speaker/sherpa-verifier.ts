/**
 * Реальный движок верификации диктора на sherpa-onnx (§3 «kill-фича»), БЕЗ ключей/аккаунтов.
 *
 * Локальная ONNX-модель отпечатка (CAM++/ECAPA) считает эмбеддинг голоса; совпадение — косинус
 * к сохранённым профилям. Мел-фронтенд и нативный рантайм — внутри sherpa-onnx (prebuilt-бинарь).
 * Крутится на СЕРВЕРЕ (клиент тонкий, телефон/слабый ПК не нагружены), параллельно аудио → ноль
 * задержки. Нет модели/библиотеки → Mock (гейт диктора выключен, реагируем на всех).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { detectGender } from "./gender-f0.js";
import {
  type EnrollSession,
  type ISpeakerVerifier,
  MockSpeakerVerifier,
  type SpeakerMatch,
  type VoiceProfile,
} from "./verifier.js";

const log: Logger = createLogger("speaker:sherpa");

/** Частота, на которой работает модель и весь голосовой тракт. */
const SAMPLE_RATE = 16_000;
/**
 * Путь к модели. ВАЖНО: нативный загрузчик sherpa-onnx (C++) НЕ открывает файлы из путей с
 * НЕ-ASCII символами (проект лежит под `…/Автокомп/…` — кириллица ломает fopen). Поэтому держим
 * модель в гарантированно ASCII-месте `~/.jarvis/models/`, а не в дереве проекта. Override —
 * env JARVIS_SPEAKER_MODEL (тоже клади в ASCII-путь).
 */
const DEFAULT_MODEL =
  process.env.JARVIS_SPEAKER_MODEL || join(homedir(), ".jarvis", "models", "speaker-embedding.onnx");
/** env-число с дефолтом и клампом (тюнинг порогов уровня без перекомпиляции). */
function envNum(name: string, def: number, lo: number, hi: number): number {
  const r = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(r) ? Math.min(hi, Math.max(lo, r)) : def;
}

/**
 * Порог косинуса «свой/чужой» (env JARVIS_SPEAKER_THRESHOLD). КАЛИБРОВКА на живом голосе
 * (2026-06-17): собственный голос даёт ~0.466 (CAM++ 3dspeaker), дефолт 0.5 его РЕЗАЛ →
 * «не слышит владельца». Снижено до 0.35 — владельцу запас, чужой/музыка дают <0.3 → отсекаются.
 * Музыка/чужие проскакивают → поднять env; режет владельца → снизить.
 */
const THRESHOLD = envNum("JARVIS_SPEAKER_THRESHOLD", 0.35, 0.2, 0.95);
/**
 * §3 Фаза 2 — ДВА ПОРОГА. accept = THRESHOLD (уверенно «свой»). reject = accept − margin
 * (уверенно «чужой»). Зона [reject, accept) — «не решили» → fail-open (гейт ПУСКАЕТ), чтобы
 * лёгкая просадка score (простуда/шум/смена мик) не запирала владельца. margin тюнится env.
 */
// УЗКАЯ анти-флап дельта (ревью: широкая зона reject=0.25 пускала чужих/музыку ~0.3). 0.04 →
// reject≈0.31, ближе к accept=0.35: импостор ~0.3 теперь отсекается, владелец ~0.466 — с запасом.
const REJECT_MARGIN = envNum("JARVIS_SPEAKER_REJECT_MARGIN", 0.04, 0, 0.5);
const REJECT_THRESHOLD = Math.max(0.1, THRESHOLD - REJECT_MARGIN);
/**
 * §3 Фаза 0 — ИД модели отпечатка. Профиль, записанный другой моделью (иная dim ИЛИ иной modelId),
 * НЕсравним косинусом → гейт его отбраковывает, а не считает мусорный score. Дефолт — текущая
 * модель CAM++ 3dspeaker 192-dim. Менять при смене модели (env JARVIS_SPEAKER_MODEL_ID).
 */
const MODEL_ID = process.env.JARVIS_SPEAKER_MODEL_ID || "campp-3dspeaker-192";
/**
 * §3 Фаза 1 — MULTI-SAMPLE ЦЕНТРОИД. Эталон копит речь и режется на фикс-окна РЕЧИ; каждое
 * эмбеддится, L2-нормируется и усредняется → центроид (тот же 192-dim blob — формат хранилища не
 * меняется). Фикс-окна безопаснее детекции пауз. Отбраковка несогласованных окон + self-check
 * закрывают «мусорный эталон глушит владельца»: если центроид не опознаёт собственную запись
 * с запасом — НЕ сохраняем (честный отказ вместо тихого вреда).
 */
const ENROLL_WINDOW_SEC = envNum("JARVIS_ENROLL_WINDOW_SEC", 4, 2, 10);
/** Окно с косинусом к черновому центроиду ниже этого — выброс (чужой сегмент/шум): отбрасываем. */
const ENROLL_OUTLIER_FLOOR = envNum("JARVIS_ENROLL_OUTLIER_FLOOR", 0.5, 0, 0.95);
/**
 * Self-check: средний косинус инлайеров к финальному центроиду ≥ этого, иначе эталон не сохраняем.
 * Ревью: должен быть СТРОГО ВЫШЕ outlier-floor (0.5), иначе после отбраковки выбросов проверка
 * тривиальна (среднее по набору максимизирует косинус к нему же → почти всегда проходит). 0.6.
 */
const ENROLL_SELFCHECK_MIN = envNum("JARVIS_ENROLL_SELFCHECK_MIN", 0.6, 0.2, 0.95);
/** Доля окон-инлайеров от всех окон; ниже → запись несогласованная (двое/эхо/ТВ) → не сохраняем. */
const ENROLL_MIN_INLIER_FRAC = envNum("JARVIS_ENROLL_MIN_INLIER_FRAC", 0.6, 0.3, 1);

/**
 * §3 КАЧЕСТВО ОТПЕЧАТКА (фикс «записал голос → Джарвис оглох»). Раньше enrollment завершался
 * по ЛЮБОМУ аудио за N секунд — эхо/тишина давали мусорный эталон, и гейт глушил даже владельца.
 * Теперь:
 *  - в прогресс идут ТОЛЬКО кадры с РЕЧЬЮ (пик ≥ ENROLL_SPEECH_PEAK) — тишина не наполняет шкалу;
 *  - на финале мало речи → null (честное «не записал», а не мусор);
 *  - enroll и identify нормируют уровень к одному пику → косинус осмыслен;
 *  - identify на тихом/коротком ходе → null (= «не решили»): гейт ПУСКАЕТ, не запирает владельца.
 * Тихий микрофон подтягивается клиентским makeup-gain (renderer/audio.ts) ещё ДО сервера.
 */
const ENROLL_SPEECH_PEAK = envNum("JARVIS_ENROLL_SPEECH_PEAK", 0.12, 0.02, 0.5);
const MIN_ENROLL_SPEECH_SEC = envNum("JARVIS_ENROLL_MIN_SPEECH_SEC", 6, 2, 30);
/** Тише/короче этого опознать нельзя → null (гейт пускает, не глушит владельца). */
const IDENTIFY_MIN_PEAK = envNum("JARVIS_IDENTIFY_MIN_PEAK", 0.06, 0.01, 0.5);
const IDENTIFY_MIN_SEC = 0.4;
/** Целевой пик нормировки перед эмбеддингом (как normalizeAudio в whisper-stt). */
const NORMALIZE_TARGET_PEAK = 0.3;
const NORMALIZE_MAX_GAIN = 8;

/** Узкая поверхность нативного экстрактора sherpa-onnx, которой пользуемся. */
interface SherpaStream {
  acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}
export interface SherpaExtractor {
  readonly dim: number;
  createStream(): SherpaStream;
  isReady(s: SherpaStream): boolean;
  compute(s: SherpaStream, enableExternalBuffer?: boolean): Float32Array;
}

export class SherpaSpeakerVerifier implements ISpeakerVerifier {
  readonly ready = true;
  /** Секунды РЕЧИ (не wall-clock: паузы не считаются) для надёжного отпечатка. */
  readonly enrollSeconds = 12;
  readonly threshold = THRESHOLD;
  readonly acceptThreshold = THRESHOLD;
  readonly rejectThreshold = REJECT_THRESHOLD;
  readonly modelId = MODEL_ID;
  /** Размерность эмбеддинга движка (Фаза 0). */
  get dim(): number {
    return this.extractor.dim;
  }
  constructor(private readonly extractor: SherpaExtractor) {}

  /** Эмбеддинг участка речи (Float32 16кГц) → вектор; null, если аудио не хватило. */
  private embed(samples: Float32Array): Float32Array | null {
    try {
      const stream = this.extractor.createStream();
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      stream.inputFinished();
      if (!this.extractor.isReady(stream)) return null; // слишком короткий фрагмент
      return this.extractor.compute(stream);
    } catch (e) {
      log.warn("ошибка вычисления эмбеддинга", e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  enroll(): EnrollSession {
    // Копим ТОЛЬКО речь (кадры с пиком ≥ порога). Тишина/эхо не наполняют шкалу и не попадают
    // в эталон → запись на молчании никогда не «завершится успешно».
    const speech: Float32Array[] = [];
    let speechSamples = 0;
    const verifier = this;
    return {
      async feed(pcm: Int16Array) {
        const f = int16ToFloat32(pcm);
        if (peakOf(f) >= ENROLL_SPEECH_PEAK) {
          speech.push(f);
          speechSamples += f.length;
        }
        return Math.min(1, speechSamples / SAMPLE_RATE / verifier.enrollSeconds);
      },
      async finish() {
        // Мало РЕЧИ (тихо/молчал) → честный отказ вместо мусорного эталона.
        if (speechSamples < SAMPLE_RATE * MIN_ENROLL_SPEECH_SEC) return null;
        return verifier.buildCentroid(concatF32(speech, speechSamples));
      },
      cancel() {
        speech.length = 0;
        speechSamples = 0;
      },
    };
  }

  async identify(pcm: Int16Array, profiles: readonly VoiceProfile[]): Promise<SpeakerMatch | null> {
    if (profiles.length === 0) return null;
    // §3 Фаза 0: сравниваем ТОЛЬКО с профилями своей модели/размерности. Профиль другой модели
    // несравним косинусом (cosine молча режет по min(len) → мусорный score). Несовместимые
    // отбрасываем; если совместимых не осталось → null (гейт пускает, а не глушит по мусору).
    const comparable = profiles.filter((p) => this.isComparable(p));
    if (comparable.length === 0) {
      log.warn("identify: нет профилей, совместимых с активной моделью отпечатка — пропускаю ход", {
        modelId: this.modelId,
        dim: this.dim,
      });
      return null;
    }
    const f = int16ToFloat32(pcm);
    // Тихо/коротко — опознать нельзя. Возвращаем null (НЕ «чужой»): гейт трактует это как
    // «не решили» и ПУСКАЕТ ход. Так enrolled-голос НИКОГДА не глушит владельца на тихом/коротком
    // обороте (раньше тихий ход → низкий score < порога → дроп → «оглох после записи голоса»).
    if (f.length < SAMPLE_RATE * IDENTIFY_MIN_SEC || peakOf(f) < IDENTIFY_MIN_PEAK) return null;
    const probe = this.embed(normalizePeak(f));
    if (!probe) return null; // фрагмент слишком короткий — вызывающий не запирает (пропускает)
    let best: SpeakerMatch | null = null;
    for (const p of comparable) {
      const score = cosine(probe, bytesToF32(p.data));
      if (!best || score > best.score) best = { name: p.name, score };
    }
    if (!best) return null;
    // §3 цель №2: пол по основному тону (F0) — параллельно биометрии, ноль доб. задержки. Доп-сигнал
    // (гейт может отсечь явно чужой пол в null-ветке), не основной критерий: на шёпоте/шуме → unknown.
    const g = detectGender(f, SAMPLE_RATE);
    best.gender = g.gender;
    best.f0Hz = g.medianF0Hz;
    return best; // лучший кандидат + пол; порог применяет гейт (различить «чужой» vs «короткий»)
  }

  /** §3 Фаза 0: совместим ли профиль с активной моделью (размерность + modelId). */
  private isComparable(p: VoiceProfile): boolean {
    const pdim = p.dim ?? p.data.byteLength >> 2; // legacy без dim → выводим из длины байт
    if (pdim !== this.dim) return false;
    if (p.modelId !== undefined && p.modelId !== this.modelId) return false;
    return true;
  }

  /**
   * §3 Фаза 1: построить центроид из речи. Режем на фикс-окна РЕЧИ, эмбеддим+L2-нормируем каждое,
   * отбраковываем выбросы, усредняем → центроид (192-dim blob, формат хранилища не меняется).
   * Self-check: средний косинус окон к центроиду ≥ порога, иначе эталон несогласован → null.
   */
  private buildCentroid(speech: Float32Array): Uint8Array | null {
    const win = Math.floor(SAMPLE_RATE * ENROLL_WINDOW_SEC);
    const minTail = Math.floor(SAMPLE_RATE * IDENTIFY_MIN_SEC);
    const vecs: Float32Array[] = [];
    for (let off = 0; off < speech.length; off += win) {
      const end = Math.min(off + win, speech.length);
      if (end - off < minTail) break; // хвост короче минимума — не эмбеддим
      const emb = this.embed(normalizePeak(speech.subarray(off, end)));
      if (emb) vecs.push(l2norm(emb));
    }
    // Не набралось окон (очень коротко) — пробуем одним эмбеддингом всей речи (не хуже прежнего).
    if (vecs.length === 0) {
      const whole = this.embed(normalizePeak(speech));
      return whole ? f32ToBytes(l2norm(whole)) : null;
    }
    if (vecs.length === 1) return f32ToBytes(vecs[0]!); // одно окно — это и есть эталон
    // ИТЕРАТИВНЫЙ РОБАСТНЫЙ ЦЕНТРОИД (ревью: одна отбраковка к загрязнённому среднему неробастна —
    // выброс тянет центроид к себе и проходит фильтр). 2 прохода: центроид → отбраковка → пересчёт.
    let centroid = l2norm(meanVec(vecs));
    let kept: Float32Array[] = vecs;
    for (let pass = 0; pass < 2; pass += 1) {
      const inliers = vecs.filter((v) => cosine(v, centroid) >= ENROLL_OUTLIER_FLOOR);
      kept = inliers; // 0 инлайеров → kept пуст → отсев по доле ниже (несогласованная запись)
      if (inliers.length === 0) break;
      centroid = l2norm(meanVec(inliers));
    }
    // ПРОВЕРКА ДОЛИ ИНЛАЙЕРОВ: много выбросов → запись несогласованная (двое/эхо/ТВ) → не сохраняем.
    const inlierFrac = kept.length / vecs.length;
    if (kept.length < 2 || inlierFrac < ENROLL_MIN_INLIER_FRAC) {
      log.warn("enroll: запись несогласованна (мало инлайеров) — не сохраняю", {
        windows: vecs.length, kept: kept.length, inlierFrac: Number(inlierFrac.toFixed(2)), need: ENROLL_MIN_INLIER_FRAC,
      });
      return null;
    }
    // SELF-CHECK (порог СТРОГО выше outlier-floor): кластер инлайеров должен быть тесным — средний
    // косинус к финальному центроиду ≥ ENROLL_SELFCHECK_MIN(0.6). Слабый кластер → мусорный эталон.
    const meanSim = kept.reduce((s, v) => s + cosine(v, centroid), 0) / kept.length;
    if (meanSim < ENROLL_SELFCHECK_MIN) {
      log.warn("enroll: self-check не пройден — эталон несогласован, не сохраняю", {
        windows: vecs.length, kept: kept.length, meanSim: Number(meanSim.toFixed(3)), need: ENROLL_SELFCHECK_MIN,
      });
      return null;
    }
    log.info("enroll: центроид построен", { windows: vecs.length, kept: kept.length, inlierFrac: Number(inlierFrac.toFixed(2)), meanSim: Number(meanSim.toFixed(3)) });
    return f32ToBytes(centroid);
  }
}

/**
 * Фабрика верификатора. Есть модель + библиотека → реальный sherpa-движок; иначе Mock
 * (ready=false → гейт диктора выключен, Джарвис реагирует на всех, как раньше). Никогда не
 * роняет старт сервера из-за отсутствия модели/нативного модуля.
 */
export async function createSpeakerVerifier(modelPath: string = DEFAULT_MODEL): Promise<ISpeakerVerifier> {
  if (!existsSync(modelPath)) {
    log.warn("модель отпечатка не найдена — верификация диктора выключена", { modelPath });
    return new MockSpeakerVerifier();
  }
  try {
    const spec = "sherpa-onnx-node"; // через переменную: не статический резолв (опц. рантайм-зависимость)
    const sherpa = (await import(spec)) as Record<string, unknown> & { default?: Record<string, unknown> };
    const mod = (sherpa.default ?? sherpa) as { SpeakerEmbeddingExtractor?: new (c: unknown) => SherpaExtractor };
    const Extractor = mod.SpeakerEmbeddingExtractor;
    if (!Extractor) throw new Error("SpeakerEmbeddingExtractor отсутствует в sherpa-onnx-node");
    const extractor = new Extractor({ model: modelPath, numThreads: 1, provider: "cpu", debug: false });
    log.info("движок отпечатка готов (sherpa-onnx, keyless)", { dim: extractor.dim, threshold: THRESHOLD });
    return new SherpaSpeakerVerifier(extractor);
  } catch (e) {
    log.warn("движок отпечатка не поднялся — верификация диктора выключена", e instanceof Error ? e.message : String(e));
    return new MockSpeakerVerifier();
  }
}

// ── чистые помощники ──────────────────────────────────────────

function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = (pcm[i] ?? 0) / 32768;
  return out;
}

/** Пик амплитуды (макс |сэмпл|) сигнала, [0..1]. */
function peakOf(f: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < f.length; i += 1) {
    const a = Math.abs(f[i] ?? 0);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Нормировка пика к целевому уровню (аналог normalizeAudio из whisper-stt): тихий микрофон →
 * стабильный уровень для эмбеддинга, БЕЗ раздувания тишины (кап усиления против шума). Enroll и
 * identify прогоняют сигнал через одну нормировку → косинус сравнивает голоса, а не громкости.
 */
function normalizePeak(f: Float32Array, target = NORMALIZE_TARGET_PEAK): Float32Array {
  const peak = peakOf(f);
  if (peak < 1e-4) return f; // практически тишина — не трогаем
  const gain = Math.min(NORMALIZE_MAX_GAIN, target / peak);
  if (gain <= 1.05) return f; // уже достаточно громко
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i += 1) out[i] = Math.max(-1, Math.min(1, (f[i] ?? 0) * gain));
  return out;
}

/** L2-нормировка вектора (единичная длина). Косинус инвариантен к масштабу, но нормированные
 *  векторы дают корректное усреднение в центроид (без перекоса по громким окнам). */
function l2norm(f: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < f.length; i += 1) n += (f[i] ?? 0) * (f[i] ?? 0);
  const norm = Math.sqrt(n);
  if (norm < 1e-8) return f;
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i += 1) out[i] = (f[i] ?? 0) / norm;
  return out;
}

/** Среднее нескольких векторов одной размерности (покомпонентно). */
function meanVec(vecs: readonly Float32Array[]): Float32Array {
  const dim = vecs[0]?.length ?? 0;
  const out = new Float32Array(dim);
  for (const v of vecs) for (let i = 0; i < dim; i += 1) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
  if (vecs.length > 0) for (let i = 0; i < dim; i += 1) out[i] = (out[i] ?? 0) / vecs.length;
  return out;
}

function concatF32(chunks: readonly Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Эмбеддинг (Float32) → байты для хранения (копия в свежий буфер). */
function f32ToBytes(f: Float32Array): Uint8Array {
  return new Uint8Array(new Float32Array(f).buffer);
}

/** Байты из хранилища → Float32 (копия, чтобы выровнять буфер по 4 байтам). */
function bytesToF32(u: Uint8Array): Float32Array {
  const copy = new Uint8Array(u); // byteOffset=0, выровнено
  return new Float32Array(copy.buffer, 0, copy.byteLength >> 2);
}

/** Косинусная близость [-1..1]. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

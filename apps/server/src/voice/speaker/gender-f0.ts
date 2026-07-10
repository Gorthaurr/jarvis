/**
 * Определение пола (муж/жен) по основному тону голоса F0 (§3, цель №2 «различать М/Ж»).
 *
 * Подход (выбор ML-инженера): СВОЙ оценщик F0 на YIN-разностной функции (de Cheveigné &
 * Kawahara, 2002) поверх уже собираемого аудио хода (turnAudio, 16кГц PCM). БЕЗ новых
 * зависимостей и БЕЗ GPL (pitchfinder — GPL-3, не берём). Чистые функции — тестируются на
 * синтетике без звукового железа.
 *
 * Почему F0, а не нейросеть-классификатор: пол сильнее всего кодируется в основном тоне
 * (муж ~85-155 Гц, жен ~165-255 Гц), это дёшево, объяснимо и не требует модели/сети. Пол —
 * ДОПОЛНИТЕЛЬНЫЙ сигнал к биометрии (guard), не основной критерий: на шёпоте/шуме F0 ненадёжен,
 * поэтому unvoiced → "unknown" (не классифицируем), а не угадываем.
 */

/** Диапазон поиска F0 человеческого голоса (Гц). Уже/шире — больше октавных ошибок/шума. */
const F0_MIN_HZ = 70;
const F0_MAX_HZ = 400;
/** Порог апериодичности YIN: минимум d'(τ) ниже него → периодичный (voiced) кадр. */
const YIN_THRESHOLD = 0.15;
/** Минимальная RMS-энергия кадра (нормированный сигнал) — тише → тишина/шум, не голос. */
const VOICED_RMS_MIN = 0.01;

/** env-число с дефолтом и клампом (тюнинг порогов без перекомпиляции). */
function envNum(name: string, def: number, lo: number, hi: number): number {
  const r = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(r) ? Math.min(hi, Math.max(lo, r)) : def;
}

/**
 * Пол по медианному F0. Мягкая зона между порогами → "unknown" (не гадаем на границе).
 * Дефолты: муж ≤ 160 Гц, жен ≥ 170 Гц (диапазоны перекрываются у низких женских/высоких мужских;
 * зона 160-170 — неуверенность). Тюнится JARVIS_GENDER_F0_MALE_MAX / _FEMALE_MIN.
 */
export type Gender = "male" | "female" | "unknown";

export function genderFromF0(medianF0Hz: number | null): Gender {
  if (medianF0Hz === null || !Number.isFinite(medianF0Hz) || medianF0Hz <= 0) return "unknown";
  // Пороги по ресёрчу: муж ≤155, жен ≥165, мягкая зона 155-165 → unknown (распределения
  // перекрываются у низких женских/высоких мужских голосов).
  const maleMax = envNum("JARVIS_GENDER_F0_MALE_MAX", 155, 100, 200);
  const femaleMin = envNum("JARVIS_GENDER_F0_FEMALE_MIN", 165, 140, 260);
  if (medianF0Hz <= maleMax) return "male";
  if (medianF0Hz >= femaleMin) return "female";
  return "unknown"; // мягкая зона перекрытия — честно не уверены
}

/** Результат оценки F0 по одному окну. */
interface FrameF0 {
  /** Частота основного тона (Гц) или null, если кадр не звонкий. */
  f0Hz: number | null;
  /** Звонкий ли кадр (периодичный + достаточная энергия). */
  voiced: boolean;
}

/** RMS-энергия окна (нормированный сигнал [-1..1]). */
function rms(buf: Float32Array, start: number, len: number): number {
  let s = 0;
  for (let i = 0; i < len; i += 1) {
    const v = buf[start + i] ?? 0;
    s += v * v;
  }
  return Math.sqrt(s / Math.max(1, len));
}

/**
 * Оценка F0 одного окна по YIN. Возвращает F0 (Гц) + voiced.
 * Шаги YIN: (1) разностная функция d(τ); (2) кумулятивно-нормированная d'(τ); (3) первый τ ниже
 * порога (или глобальный минимум); (4) параболическая интерполяция для суб-сэмплной точности.
 * τ ∈ [sr/F0_MAX, sr/F0_MIN]. Окно должно быть ≥ 2·τ_max.
 */
export function estimateF0Window(buf: Float32Array, start: number, windowLen: number, sampleRate: number): FrameF0 {
  if (rms(buf, start, windowLen) < VOICED_RMS_MIN) return { f0Hz: null, voiced: false };
  const tauMin = Math.max(2, Math.floor(sampleRate / F0_MAX_HZ));
  const tauMax = Math.min(Math.floor(windowLen / 2) - 1, Math.ceil(sampleRate / F0_MIN_HZ));
  if (tauMax <= tauMin) return { f0Hz: null, voiced: false };

  // (1) разностная функция d(τ) = Σ (x[j]-x[j+τ])²
  const diff = new Float32Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    let sum = 0;
    for (let j = 0; j < windowLen - tau; j += 1) {
      const a = buf[start + j] ?? 0;
      const b = buf[start + j + tau] ?? 0;
      const d = a - b;
      sum += d * d;
    }
    diff[tau] = sum;
  }

  // (2) кумулятивно-нормированная d'(τ): d'(τ) = d(τ) / [(1/τ) Σ_{1..τ} d(j)]
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau += 1) {
    running += diff[tau] ?? 0;
    cmnd[tau] = running > 0 ? ((diff[tau] ?? 0) * tau) / running : 1;
  }

  // (3) первый τ ниже порога с локальным минимумом (анти-октавная защита: берём ПЕРВЫЙ провал,
  // а не глобальный — кратные периоды дают минимумы на 2τ/3τ). Иначе — глобальный минимум.
  let bestTau = -1;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    if ((cmnd[tau] ?? 1) < YIN_THRESHOLD) {
      let t = tau;
      while (t + 1 <= tauMax && (cmnd[t + 1] ?? 1) < (cmnd[t] ?? 1)) t += 1; // спуск к дну провала
      bestTau = t;
      break;
    }
  }
  if (bestTau === -1) {
    // нет уверенного провала — самый глубокий минимум; если он не глубок → не звонкий
    let minVal = Number.POSITIVE_INFINITY;
    for (let tau = tauMin; tau <= tauMax; tau += 1) {
      if ((cmnd[tau] ?? 1) < minVal) {
        minVal = cmnd[tau] ?? 1;
        bestTau = tau;
      }
    }
    if (minVal > 0.5) return { f0Hz: null, voiced: false }; // слишком апериодично — unvoiced
  }

  // (4) параболическая интерполяция вокруг bestTau (суб-сэмплная точность).
  const x0 = cmnd[bestTau - 1] ?? cmnd[bestTau] ?? 0;
  const x1 = cmnd[bestTau] ?? 0;
  const x2 = cmnd[bestTau + 1] ?? cmnd[bestTau] ?? 0;
  const denom = x0 + x2 - 2 * x1;
  const shift = denom !== 0 ? (0.5 * (x0 - x2)) / denom : 0;
  const tauRefined = bestTau + (Number.isFinite(shift) && Math.abs(shift) < 1 ? shift : 0);
  const f0 = sampleRate / tauRefined;
  if (f0 < F0_MIN_HZ || f0 > F0_MAX_HZ) return { f0Hz: null, voiced: false };
  return { f0Hz: f0, voiced: true };
}

/** Float32 из Int16 PCM (как в sherpa-verifier). */
function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = (pcm[i] ?? 0) / 32768;
  return out;
}

/** Медиана массива (копия, не мутирует вход). */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : ((s[mid - 1]! + s[mid]!) / 2);
}

/** Сводная статистика F0 по сигналу (для калибровки владельца при enroll и метки на ходе). */
export interface F0Stats {
  /** Медианный F0 по звонким окнам (Гц) или null, если звонких окон мало. */
  medianHz: number | null;
  /** Доля звонких окон [0..1]. */
  voicedRatio: number;
  /** Сколько звонких окон учтено. */
  voicedFrames: number;
}

/**
 * Оценить F0-статистику сигнала: скользящие окна, F0 на каждом звонком, МЕДИАНА (робастна к
 * октавным выбросам и шуму). Окно 1024 (≈64мс @16к) с шагом 512 — баланс точность/устойчивость.
 * medianHz=null, если звонких окон меньше minVoiced (нельзя надёжно судить о поле).
 */
export function f0Stats(pcm: Int16Array | Float32Array, sampleRate = 16_000, minVoiced = 5): F0Stats {
  const buf = pcm instanceof Int16Array ? int16ToFloat32(pcm) : pcm;
  const win = 1024;
  const hop = 512;
  if (buf.length < win) return { medianHz: null, voicedRatio: 0, voicedFrames: 0 };
  const f0s: number[] = [];
  let total = 0;
  for (let start = 0; start + win <= buf.length; start += hop) {
    total += 1;
    const r = estimateF0Window(buf, start, win, sampleRate);
    if (r.voiced && r.f0Hz !== null) f0s.push(r.f0Hz);
  }
  const voicedRatio = total > 0 ? f0s.length / total : 0;
  return {
    medianHz: f0s.length >= minVoiced ? median(f0s) : null,
    voicedRatio,
    voicedFrames: f0s.length,
  };
}

/** Удобная обёртка: пол по сигналу напрямую (медиана F0 → genderFromF0). */
export function detectGender(pcm: Int16Array | Float32Array, sampleRate = 16_000): { gender: Gender; medianF0Hz: number | null } {
  const stats = f0Stats(pcm, sampleRate);
  return { gender: genderFromF0(stats.medianHz), medianF0Hz: stats.medianHz };
}

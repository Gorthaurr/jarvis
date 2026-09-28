/**
 * Запись ОДНОГО отрезка речи при закрытом гейте (подстраховка «Джарвис», 28.09).
 *
 * Держит кольцо последних кадров (пре-ролл до онсета VAD: он срабатывает после 3 громких кадров, начало слова
 * уже прошло) и копит кадры между speech_start и speech_end. Память ограничена: длиннее maxFrames — отрезок
 * бросается (это не обращение, а фон), ничего не растёт. Аудио живёт только здесь и уходит не дальше take().
 */
import type { VadSignal } from "../vad/index.js";

/** Кадр — 20 мс (320 сэмплов при 16 кГц): 25 кадров пре-ролла = 0,5 с; 260 кадров ≈ 5,2 с — потолок отрезка. */
const PRE_FRAMES = 25;
const MAX_FRAMES = 260;

export class SegmentRecorder {
  private pre: Int16Array[] = [];
  private seg: Int16Array[] | null = null;

  constructor(private readonly preFrames = PRE_FRAMES, private readonly maxFrames = MAX_FRAMES) {}

  /** Кадр + сигнал VAD этого кадра + идёт ли речь после него. */
  push(frame: Int16Array, sig: VadSignal, speaking: boolean): void {
    const copy = Int16Array.from(frame);
    this.pre.push(copy);
    if (this.pre.length > this.preFrames) this.pre.shift();
    if (sig === "speech_start") {
      this.seg = [...this.pre]; // текущий кадр уже в кольце
      return;
    }
    if (this.seg && (speaking || sig === "speech_end")) {
      this.seg.push(copy);
      if (this.seg.length > this.maxFrames) this.seg = null; // слишком длинно — фон, не обращение
    }
  }

  /** Забрать записанный отрезок одним буфером (и забыть его). null — отрезка нет/он сброшен. */
  take(): Int16Array | null {
    const s = this.seg;
    this.seg = null;
    if (!s || s.length === 0) return null;
    const out = new Int16Array(s.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of s) {
      out.set(f, at);
      at += f.length;
    }
    return out;
  }

  reset(): void {
    this.pre = [];
    this.seg = null;
  }
}

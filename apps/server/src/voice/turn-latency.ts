/**
 * Латентность ПО ХОДАМ (аудит прод-логов 27.09, B4).
 *
 * Раньше на пайплайн был ОДИН изменяемый LatencyTracker: новый STT-лиз (речь в раздумье, барж-ин) сбрасывал
 * его, пока прошлый ход ещё думал или говорил. Звук ответа прошлого хода ложился в трекер НОВОГО хода (метка
 * «первая побеждает») → firstAudioMs < 0 → «оборот неполный» (69 % строк latency:), а сам прошлый ход терял
 * свой turn_end. Здесь у каждого хода (turnSeq) свой трекер; метка без хода (проактив, фоновый итог без тега)
 * не пишется никуда — это не ответ ни на чью фразу.
 */
import { type LatencyMark, type LatencyReport, LatencyTracker } from "./latency.js";

/** Сколько последних ходов помним: ответ долгого хода звучит через 1–2 следующих лиза (follow-up, шорох). */
const KEEP_TURNS = 8;

export class TurnLatency {
  private readonly turns = new Map<number, LatencyTracker>();
  /** Ход, чей ответ сейчас в работе (runAgent) — для меток от вызывающих, не знающих своего хода (earcon приёмки). */
  private answering: number | undefined;

  constructor(private readonly now: () => number) {}

  /** Новый ход (открыт STT-лиз): свой чистый трекер с меткой wake. Трекеры прошлых ходов живут — их звук ещё придёт. */
  begin(seq: number): void {
    const t = new LatencyTracker(this.now);
    t.mark("wake");
    this.turns.set(seq, t);
    while (this.turns.size > KEEP_TURNS) this.turns.delete(this.turns.keys().next().value as number);
  }

  /** Ход seq пошёл в мозг (начало runAgent). Возвращает seq — вызывающий держит его весь ход. */
  answer(seq: number): number {
    this.answering = seq;
    return seq;
  }

  /** Ход, чей ответ сейчас в работе (undefined — ещё ни одного). */
  get answeringSeq(): number | undefined {
    return this.answering;
  }

  /** Метка стадии хода seq (первая запись побеждает). Ход не отслеживается или seq нет → no-op. */
  mark(seq: number | undefined, stage: LatencyMark): void {
    if (seq !== undefined) this.turns.get(seq)?.mark(stage);
  }

  /** Метка с конкретным временем (ack клиента audio.played приходит с его отметкой). */
  markAt(seq: number | undefined, stage: LatencyMark, ts: number): void {
    if (seq !== undefined) this.turns.get(seq)?.markAt(stage, ts);
  }

  /**
   * Первый звук хода ОТПРАВЛЕН клиенту: tts_first_chunk + audio в трекер СВОЕГО хода. Отчёт хода — для строки
   * latency:; undefined — звук ничей (проактив/фон без тега) или ход уже забыт: строку не пишем, она солгала бы.
   */
  sound(seq: number | undefined): LatencyReport | undefined {
    const t = seq === undefined ? undefined : this.turns.get(seq);
    if (!t) return undefined;
    t.mark("tts_first_chunk");
    t.mark("audio");
    return t.report();
  }

  /** Отчёт хода seq (неизвестный ход — пустой отчёт «неполный», не чужие метки). */
  report(seq: number | undefined): LatencyReport {
    const t = seq === undefined ? undefined : this.turns.get(seq);
    return (t ?? new LatencyTracker(this.now)).report();
  }
}

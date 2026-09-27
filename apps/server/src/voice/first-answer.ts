/**
 * W3 (V-1 = L-9): ПЕРВЫЙ СОДЕРЖАТЕЛЬНЫЙ ОТВЕТ хода — метрика `first_answer`.
 *
 * `mouth_to_ear` честно меряет ПЕРВЫЙ звук хода, но на ходу с руками первым звучит служебное «Берусь, сэр»
 * (ack промоушена) или прекеш-филлер — метрика закрывалась на нём и рапортовала «быстро», а итог промотированной
 * задачи (через очередь озвучки, без тега хода) не мерился вовсе. Здесь по каждому ходу (turnSeq):
 *  - какой звук ушёл ПЕРВЫМ (answer / ack / filler) — поле `firstSound` строки mouth_to_ear;
 *  - `first_answer` = turn_end → ОТПРАВКА первого аудиочанка содержательного ответа (серверное время):
 *    path "sync" — ответ этим же ходом (первая фраза не ack и не филлер), "promoted" — итог фоновой задачи,
 *    промотированной из этого хода (speakResult → очередь с answerOf).
 * Один ответ на ход; последние {@link KEEP_TURNS} ходов держим — итог промоушена приходит через несколько ходов.
 */

export type FirstSound = "answer" | "ack" | "filler";
export type AnswerPath = "sync" | "promoted";

interface TurnMark {
  turnEndTs: number;
  first?: FirstSound;
  answered: boolean;
}

const KEEP_TURNS = 16;

export class FirstAnswerTracker {
  private readonly turns = new Map<number, TurnMark>();

  constructor(
    private readonly now: () => number,
    private readonly onFirstAnswer?: (ms: number, turnSeq: number, path: AnswerPath) => void,
  ) {}

  /** Конец речи владельца хода seq (turn_end). Повтор для того же хода не сдвигает отметку. */
  begin(seq: number, turnEndTs: number): void {
    if (this.turns.has(seq)) return;
    this.turns.set(seq, { turnEndTs, answered: false });
    while (this.turns.size > KEEP_TURNS) this.turns.delete(this.turns.keys().next().value as number);
  }

  /**
   * Ушёл чанк звука хода seq С ТЕГОМ хода (им клиент замкнёт mouth-to-ear): первый такой задаёт firstSound;
   * содержательный ответ (answer) закрывает first_answer по пути sync.
   */
  sound(seq: number | undefined, kind: FirstSound): void {
    if (seq === undefined) return;
    const t = this.turns.get(seq);
    if (!t) return;
    t.first ??= kind;
    if (kind === "answer") this.answer(seq, t, "sync");
  }

  /** Ушёл первый чанк итога задачи, промотированной из хода seq (очередь озвучки, без тега хода). */
  promoted(seq: number | undefined): void {
    if (seq === undefined) return;
    const t = this.turns.get(seq);
    if (t) this.answer(seq, t, "promoted");
  }

  /** Каким был первый звук хода (для строки mouth_to_ear); undefined — ход не отслеживается. */
  firstSound(seq: number): FirstSound | undefined {
    return this.turns.get(seq)?.first;
  }

  private answer(seq: number, t: TurnMark, path: AnswerPath): void {
    if (t.answered) return;
    t.answered = true;
    const ms = this.now() - t.turnEndTs;
    if (Number.isFinite(ms) && ms >= 0) this.onFirstAnswer?.(Math.round(ms), seq, path);
  }
}

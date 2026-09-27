/**
 * Снапшоты ходов для mouth-to-ear: {seq → turn_end}. Отдельно от трекеров латентности: ack клиента (audio.played)
 * приходит раунд-трипом позже звука, и снапшот обязан его дождаться. Один ack на ход — снапшот забирается.
 *
 * Ревью р1 B4 (аудит 27.09): раньше слот был ОДИН. Шум в раздумье (кашель/ТВ) открывал лиз следующего хода, его
 * finalizeStt перезаписывал слот, и ack ответа прошлого хода (честно теговый своим seq после B4) отбрасывался
 * МОЛЧА — главный KPI латентности терял каждый ход с речью в раздумье (перекос к тихим ходам). Здесь у каждого
 * хода свой снапшот (последние KEEP_TURNS — как FirstAnswerTracker), а промах вызывающий пишет в лог.
 */
const KEEP_TURNS = 16;

/** Почему ack не сошёлся: ход уже замкнут (повторный ack) или не отслеживается (нет turn_end/вытеснен). */
export type M2eMiss = "closed" | "unknown";

export class M2eSnapshots {
  /** seq → turn_end (мс); null — ack этого хода уже принят. */
  private readonly turns = new Map<number, number | null>();

  /** Конец речи владельца хода seq. */
  capture(seq: number, turnEndTs: number): void {
    this.turns.delete(seq); // свежая запись — в конец порядка вытеснения
    this.turns.set(seq, turnEndTs);
    while (this.turns.size > KEEP_TURNS) this.turns.delete(this.turns.keys().next().value as number);
  }

  /** Забрать turn_end хода для его ack (один раз); промах — причина. */
  take(seq: number): { turnEndTs: number } | { miss: M2eMiss } {
    const te = this.turns.get(seq);
    if (te === undefined) return { miss: "unknown" };
    if (te === null) return { miss: "closed" };
    this.turns.set(seq, null);
    return { turnEndTs: te };
  }
}

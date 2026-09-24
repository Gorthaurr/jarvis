/**
 * Таймер закрытия гейта микрофона «по тишине» (ревью 2026-09-24, B-F3; вынесено из audio/index.ts).
 *
 * Было (W1): сервер в listening дольше 10 с без нового хода → гейт закрывался ВСЛЕПУЮ, даже посреди
 * фразы владельца. Итог: хвост команды не уходил в облако, а сервер, получивший speech_start, так и не
 * получал speech_end — `userSpeaking` залипал, и фоновые итоги не звучали (их дренаж ждёт тишины).
 *
 * Стало — два таймера:
 *  • idle — сдвигается КАЖДЫМ речевым кадром (`touch`): гейт закрывается только через idleMs ПОСЛЕ
 *    конца речи, а не через idleMs после входа в listening;
 *  • cap — жёсткий потолок от взвода, речью НЕ сдвигается. Без него ТВ/Discord в комнате (VAD видит в
 *    них речь) держали бы гейт открытым вечно — ровно та W1-поломка, ради которой таймер и заводился.
 *
 * Перевзвод на каждом речевом кадре (~50 раз/с) дёшев для Node-таймеров и не зависит от инжектируемых
 * часов — поэтому здесь нет арифметики дедлайнов по `now()`.
 */
export type GateCloseKind = "idle" | "cap";

export class GateCloser {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private idleMs = 0;

  /** onFire решает сам, закрывать ли гейт (состояние сервера/удержание/mute живут у координатора). */
  constructor(private readonly onFire: (kind: GateCloseKind) => void) {}

  get armed(): boolean {
    return this.idleTimer !== null || this.capTimer !== null;
  }

  /** Взвести заново: тишина idleMs → idle; в любом случае не дольше capMs → cap. */
  arm(idleMs: number, capMs: number): void {
    this.clear();
    this.idleMs = idleMs;
    this.startIdle();
    this.capTimer = setTimeout(() => {
      this.capTimer = null;
      this.onFire("cap");
    }, capMs);
    this.capTimer.unref?.();
  }

  /** Речевой кадр: сдвинуть дедлайн тишины (потолок не трогаем). No-op, если не взведён. */
  touch(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.startIdle();
  }

  clear(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.capTimer) clearTimeout(this.capTimer);
    this.idleTimer = null;
    this.capTimer = null;
  }

  private startIdle(): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.onFire("idle");
    }, this.idleMs);
    this.idleTimer.unref?.();
  }
}

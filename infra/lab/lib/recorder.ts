/**
 * Рекордер событий лаб-клиента: ВСЁ входящее/исходящее в порядке прихода. Источник правды для сборки TurnResult и для
 * инспекции (`events()`). Ограничен по размеру (кольцо), но счётчик `length` монотонен: метка хода = length на момент
 * отправки, поэтому обрезка старого не сдвигает выборку `since(mark)`.
 */
import type { LabClient } from "./contracts.js";

/** Событие журнала. `id` — id конверта (для action.command это commandId): расширение контракта, структурно совместимое. */
export type LabEvent = ReturnType<LabClient["events"]>[number] & { id?: string };

export class EventRecorder {
  private list: LabEvent[] = [];
  /** Сколько событий выкинуто из головы кольца. */
  private dropped = 0;
  private readonly listeners = new Set<(e: LabEvent) => void>();

  constructor(
    private readonly max = 5000,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Сколько событий записано за всё время (монотонно). */
  get length(): number {
    return this.dropped + this.list.length;
  }

  push(dir: LabEvent["dir"], type: string, payload: unknown, id?: string): LabEvent {
    const e: LabEvent = { at: this.clock(), dir, type, payload, ...(id ? { id } : {}) };
    this.list.push(e);
    if (this.list.length > this.max) {
      this.list.shift();
      this.dropped += 1;
    }
    for (const cb of [...this.listeners]) cb(e);
    return e;
  }

  all(): LabEvent[] {
    return [...this.list];
  }

  /** События, записанные после метки `mark` (значение `length` в момент метки). Слишком старая метка → всё, что осталось. */
  since(mark: number): LabEvent[] {
    return this.list.slice(Math.max(0, mark - this.dropped));
  }

  subscribe(cb: (e: LabEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

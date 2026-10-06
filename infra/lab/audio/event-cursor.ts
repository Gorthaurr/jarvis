/**
 * Курсор по журналу LabClient. Журнал — кольцо (5000 событий), а исходящие audio.frame по 50 шт/с забивают его за ~100 с,
 * поэтому индекс `events().length` после переполнения врёт (курсор уезжает за конец, новые события «не приходят»).
 * Метка — САМО последнее событие (по ссылке): всё, что записано после него, и есть новое. Метка вытеснена из кольца —
 * отдаём всё, что осталось (лучше повтор хвоста, чем молчаливая потеря).
 */
import type { LabClient } from "../lib/contracts.js";

export type LabEvent = ReturnType<LabClient["events"]>[number];

export class EventCursor {
  private mark: LabEvent | undefined;

  constructor(private readonly client: Pick<LabClient, "events">) {
    this.mark = client.events().at(-1);
  }

  /** События после метки; метка сдвигается на последнее из них. */
  take(): LabEvent[] {
    const evs = this.client.events();
    const fresh = sliceAfter(evs, this.mark);
    const last = fresh.at(-1);
    if (last) this.mark = last;
    return fresh;
  }
}

/** Хвост журнала после события `mark` (по ссылке). Нет метки / вытеснена — весь журнал. */
export function sliceAfter(evs: LabEvent[], mark: LabEvent | undefined): LabEvent[] {
  if (!mark) return evs;
  const i = evs.lastIndexOf(mark);
  return i < 0 ? evs : evs.slice(i + 1);
}

/** Курсор журнала: кольцо LabClient вытесняет старое, индексы по `length` после этого врут. */
import { describe, expect, it } from "vitest";
import { EventCursor, type LabEvent, sliceAfter } from "./event-cursor.js";

const ev = (n: number): LabEvent => ({ at: n, dir: "in", type: `e${n}`, payload: n });

/** Журнал-кольцо на `max` событий (как EventRecorder). */
function ring(max: number) {
  let list: LabEvent[] = [];
  return { push: (e: LabEvent) => void (list = [...list, e].slice(-max)), events: () => [...list] };
}

describe("EventCursor", () => {
  it("отдаёт каждое событие ровно один раз, в порядке прихода", () => {
    const r = ring(100);
    const c = new EventCursor(r);
    r.push(ev(1));
    r.push(ev(2));
    expect(c.take().map((e) => e.type)).toEqual(["e1", "e2"]);
    expect(c.take()).toEqual([]);
    r.push(ev(3));
    expect(c.take().map((e) => e.type)).toEqual(["e3"]);
  });

  it("события до создания курсора не отдаёт", () => {
    const r = ring(100);
    r.push(ev(1));
    const c = new EventCursor(r);
    r.push(ev(2));
    expect(c.take().map((e) => e.type)).toEqual(["e2"]);
  });

  it("после переполнения кольца не теряет новое и не повторяет старое (индекс length здесь ломается)", () => {
    const r = ring(5);
    const c = new EventCursor(r);
    const got: string[] = [];
    for (let i = 1; i <= 40; i += 1) {
      r.push(ev(i));
      if (i % 3 === 0) got.push(...c.take().map((e) => e.type)); // забираем реже, чем кольцо оборачивается? нет — влезает в 5
    }
    got.push(...c.take().map((e) => e.type));
    expect(got).toEqual(Array.from({ length: 40 }, (_, i) => `e${i + 1}`));
  });

  it("метка вытеснена (забирали слишком редко) — отдаёт весь остаток кольца, а не пустоту", () => {
    const r = ring(3);
    const c = new EventCursor(r);
    for (let i = 1; i <= 10; i += 1) r.push(ev(i));
    expect(c.take().map((e) => e.type)).toEqual(["e8", "e9", "e10"]);
  });

  it("sliceAfter: без метки — всё; метка в конце — пусто", () => {
    const evs = [ev(1), ev(2)];
    expect(sliceAfter(evs, undefined)).toEqual(evs);
    expect(sliceAfter(evs, evs[1])).toEqual([]);
  });
});

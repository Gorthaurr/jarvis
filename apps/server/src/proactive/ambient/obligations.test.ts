import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObligationStore, createObligationsSource, makeObligation, obligationSignal, upcomingDue } from "./obligations.js";
import type { Obligation } from "./obligations.js";

const DAY = 24 * 3600_000;
let n = 0;
const tempStore = () => new ObligationStore(join(tmpdir(), `jarvis-oblig-${process.pid}-${n++}`));
const ob = (over: Partial<Obligation>): Obligation => ({ id: "o1", userId: "u1", what: "счёт за свет", createdAt: 0, ...over });

describe("обязательства — дата-логика срабатывания", () => {
  it("upcomingDue: разовое → dueAt; ежемесячное → ближайший день месяца", () => {
    const now = new Date(2026, 6, 10, 9, 0, 0).getTime(); // 10 июля 2026
    expect(upcomingDue(ob({ dueAt: now + 5 * DAY }), now)).toBe(now + 5 * DAY);
    // день 15 ещё впереди в этом месяце
    const due15 = upcomingDue(ob({ recurringDay: 15 }), now)!;
    expect(new Date(due15).getDate()).toBe(15);
    expect(new Date(due15).getMonth()).toBe(6); // июль
    // день 5 уже прошёл → следующий месяц (август)
    const due5 = upcomingDue(ob({ recurringDay: 5 }), now)!;
    expect(new Date(due5).getDate()).toBe(5);
    expect(new Date(due5).getMonth()).toBe(7); // август
  });

  it("obligationSignal: далеко → null; ~2 дня → «скоро» (0.6, не срочно); сегодня → «день оплаты» (срочно)", () => {
    const now = Date.UTC(2026, 6, 10, 9, 0, 0);
    const warn = 2 * DAY;
    expect(obligationSignal(ob({ dueAt: now + 10 * DAY }), now, warn)).toBeNull(); // ещё рано
    const soon = obligationSignal(ob({ dueAt: now + 2 * DAY - 3600_000, amount: "3000 ₽" }), now, warn)!;
    expect(soon).not.toBeNull();
    expect(soon.urgent).toBe(false);
    expect(soon.salience).toBeCloseTo(0.6);
    expect(soon.key).toContain(":soon");
    expect(soon.title).toContain("свет");
    expect(soon.title).toContain("3000");
    const due = obligationSignal(ob({ dueAt: now + 2 * 3600_000 }), now, warn)!; // сегодня
    expect(due.urgent).toBe(true);
    expect(due.salience).toBeCloseTo(0.95);
    expect(due.key).toContain(":due");
    // сильно просрочено → null (не долбим вечно)
    expect(obligationSignal(ob({ dueAt: now - 5 * DAY }), now, warn)).toBeNull();
  });

  it("источник poll отдаёт сигналы по созревшим обязательствам; стор: add/list/cancel по тексту; makeObligation валидирует", async () => {
    const store = tempStore();
    const now = Date.UTC(2026, 6, 10, 9, 0, 0);
    const o1 = makeObligation({ userId: "u1", what: "счёт за свет", amount: "3000 ₽", dueAt: now + 3600_000, now })!;
    const o2 = makeObligation({ userId: "u1", what: "аренда", recurringDay: 1, now })!;
    expect(o1).toBeTruthy();
    expect(makeObligation({ userId: "u1", what: "  ", dueAt: now, now })).toBeNull(); // пустое what
    expect(makeObligation({ userId: "u1", what: "без срока", now })).toBeNull(); // нет dueAt/recurringDay
    store.add(o1);
    store.add(o2);
    expect(store.list("u1")).toHaveLength(2);

    const src = createObligationsSource(store, { now: () => now, warnMs: 2 * DAY });
    const sigs = await src.poll();
    expect(sigs.some((s) => s.title.includes("свет"))).toBe(true); // свет — сегодня → сигнал есть

    // cancel по фрагменту what
    expect(store.cancel("свет", "u1")?.what).toContain("свет");
    expect(store.list("u1")).toHaveLength(1);
  });
});

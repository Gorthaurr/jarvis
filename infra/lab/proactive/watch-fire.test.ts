/**
 * Наблюдения (watch) на виртуальных часах: каденция проверок ровно по интервалу, сработало / не сработало / сработало
 * дважды (только после реального «отлипания»), клиентский предикат, слепота и dead-watch. Доставка - через настоящую очередь.
 */
import { describe, it } from "vitest";
import { OWNER, secs, useLab, watch } from "./helpers.js";
import { expect } from "./kit.js";
import type { ProactiveLab } from "./lab.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Проверяльщик по сценарию: i-я проверка (с 1) возвращает met по `plan(i)`; времена вызовов пишутся. */
function scripted(lab: ProactiveLab, plan: (i: number) => boolean): number[] {
  const calls: number[] = [];
  lab.script.checker = async () => {
    calls.push(Date.now());
    return { met: plan(calls.length), summary: "Курс упал ниже порога." };
  };
  return calls;
}

describe("каденция и срабатывание LLM-наблюдения", () => {
  const t = useLab({ start: "2026-07-29T08:00:00" });

  it("проверки идут ровно каждые 5 минут (первая сразу), без дрейфа за час", async () => {
    const { lab } = t;
    lab.connect();
    const t0 = lab.clock.now();
    const calls = scripted(lab, () => false);
    watch(lab, { intervalMs: 5 * MIN });
    await lab.clock.advance(HOUR);
    expect(secs(calls, t0)).toEqual(Array.from({ length: 13 }, (_, k) => k * 300));
    expect(lab.spoken()).toEqual([]); // условие не выполнялось - тишина
  });

  it("one-shot: сработало на 3-й проверке - одно уведомление в момент проверки и больше не проверяет", async () => {
    const { lab } = t;
    lab.connect();
    const t0 = lab.clock.now();
    const calls = scripted(lab, (i) => i === 3);
    watch(lab, { intervalMs: 5 * MIN });
    await lab.clock.advance(2 * HOUR);
    expect(lab.spoken()).toEqual(["Курс упал ниже порога."]);
    expect(lab.journal.soundTimes()).toEqual([t0 + 10 * MIN]);
    expect(calls).toHaveLength(3); // после срабатывания проверки прекращены
    expect(lab.svc.watch.list({ userId: OWNER })).toEqual([]);
  });

  it("continuous: удерживающееся условие звучит один раз; после «отлипло» и нового срабатывания - второй", async () => {
    const { lab } = t;
    lab.connect();
    const calls = scripted(lab, (i) => (i >= 2 && i <= 5) || i >= 8); // met 2..5, отлипло 6-7, снова с 8
    watch(lab, { intervalMs: MIN, continuous: true });
    await lab.clock.advance(12 * MIN);
    expect(calls.length).toBeGreaterThanOrEqual(12);
    expect(lab.spoken()).toEqual(["Курс упал ниже порога.", "Курс упал ниже порога."]);
    expect(lab.journal.soundTimes().map((x) => (x - lab.journal.soundTimes()[0]!) / MIN)).toEqual([0, 6]);
  });
});

describe("клиентский предикат (wait.for)", () => {
  const t = useLab({ start: "2026-07-29T08:00:00" });
  const predicate = { kind: "text", contains: "матч найден" };

  it("проверки раз в 5 с, срабатывание при появлении условия - одно уведомление, проверки прекращаются", async () => {
    const { lab } = t;
    lab.connect();
    const t0 = lab.clock.now();
    watch(lab, { what: "поиск матча", condition: "матч найден", intervalMs: 5_000, predicate });
    await lab.clock.advance(30_000);
    expect(lab.predicate.calls).toBe(7); // 0,5,...,30 с
    expect(lab.spoken()).toEqual([]);
    lab.predicate.met = true;
    await lab.clock.advance(5_000);
    expect(lab.spoken()).toEqual(["Сработало: матч найден."]);
    expect(secs(lab.journal.soundTimes(), t0)).toEqual([35]);
    await lab.clock.advance(HOUR);
    expect(lab.predicate.calls).toBe(8); // one-shot завершён
  });

  it("владельца нет: проверки транзиентны (не dead-watch), а через 6 часов слепоты - ОДНО «не могу наблюдать» при подключении", async () => {
    const { lab } = t;
    watch(lab, { what: "поиск матча", condition: "матч найден", intervalMs: MIN, predicate });
    await lab.clock.advance(6 * HOUR - MIN);
    expect(lab.svc.watch.list({ userId: OWNER })).toHaveLength(1); // жив, не suspended
    await lab.clock.advance(2 * MIN);
    lab.connect();
    await lab.clock.advance(30_000);
    const said = lab.spoken().filter((s) => s.includes("Не могу наблюдать"));
    expect(said).toHaveLength(1);
    await lab.clock.advance(3 * HOUR);
    expect(lab.spoken().filter((s) => s.includes("Не могу наблюдать"))).toHaveLength(1); // не спамит
  });

  it("dead-watch: 10 провалов подряд -> приостановлено, одно честное сообщение, дальше проверок нет", async () => {
    const { lab } = t;
    lab.connect();
    lab.predicate.error = "сенсор сломан";
    watch(lab, { what: "поиск матча", condition: "матч найден", intervalMs: 5_000, predicate });
    await lab.clock.advance(10 * MIN);
    expect(lab.predicate.calls).toBe(10);
    expect(lab.svc.watch.list({ userId: OWNER })).toEqual([]);
    expect(lab.spoken()).toHaveLength(1);
    expect(lab.spoken()[0]).toContain("Не смог наблюдать");
  });
});

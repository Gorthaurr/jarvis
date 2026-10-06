/**
 * Счета и обязательства (ambient-источник) на виртуальных часах: «скоро» за 2 дня, «в день оплаты» срочно, каждое - один раз;
 * занятость и офлайн не теряют, ежемесячные повторяются. Часы тикают раз в час (интервал ambient настроен стендом).
 */
import { describe, it } from "vitest";
import { makeObligation } from "../../../apps/server/src/proactive/ambient/obligations.js";
import { OWNER, useLab } from "./helpers.js";
import { DEFECTS, expect } from "./kit.js";
import type { ProactiveLab } from "./lab.js";

const HOUR = 3_600_000;
const bill = (lab: ProactiveLab, due: string, what = "аренду"): void =>
  lab.svc.obligations.add(makeObligation({ userId: OWNER, what, dueAt: lab.clock.at(due), now: Date.now() })!);
const at = (lab: ProactiveLab): string[] => lab.journal.soundTimes().map((x) => lab.clock.fmt(x).slice(5, 16));

describe("разовый счёт со сроком 30.07 12:00", () => {
  const t = useLab({ start: "2026-07-27T09:00:00", tz: "Europe/Moscow", ambientIntervalMs: HOUR });

  it("«скоро» за двое суток и «в день оплаты» срочно - по разу; дальше, включая просрочку до двух суток, молчание", async () => {
    const { lab } = t;
    lab.connect();
    bill(lab, "2026-07-30T12:00:00");
    await lab.clock.advanceTo("2026-08-03T00:00:00");
    expect(at(lab)).toEqual(["07-28 12:00", "07-29 12:00"]);
    expect(lab.spoken()[0]).toContain("скоро");
    expect(lab.spoken()[1]).toContain("оплатить — аренду");
  });

  it("владелец занят весь день: «скоро» не теряется и звучит, когда освободился; срочное проходит и при занятости", async () => {
    const { lab } = t;
    const owner = lab.connect({ busy: true });
    bill(lab, "2026-07-30T12:00:00");
    await lab.clock.advanceTo("2026-07-29T08:30:00");
    expect(lab.spoken()).toEqual([]); // сутки занят: несрочное придержано, не выброшено
    owner.busy = false;
    await lab.clock.advanceTo("2026-07-29T13:00:00");
    expect(at(lab)).toEqual(["07-29 09:00", "07-29 12:00"]);
    owner.busy = true;
    await lab.clock.advance(HOUR);
    expect(lab.spoken()).toHaveLength(2);
  });

  it("владельца нет, сервер перезапустили: срочный счёт не забыт и звучит один раз после подключения", async () => {
    const { lab } = t;
    bill(lab, "2026-07-30T12:00:00");
    await lab.clock.advanceTo("2026-07-29T14:00:00"); // «в день оплаты» уже висит в pending в ОЗУ
    expect(lab.spoken()).toEqual([]);
    await lab.crash(); // pending пропал, на диске seen не записан
    lab.connect();
    await lab.clock.advanceTo("2026-07-29T16:00:00");
    expect(lab.spoken()).toHaveLength(1);
    expect(lab.spoken()[0]).toContain("оплатить");
    await lab.clock.advance(24 * HOUR);
    expect(lab.spoken()).toHaveLength(1);
  });

  it.skipIf(!DEFECTS)("ДЕФЕКТ: срок завтра озвучивается как «сегодня» (obligations.ts:148 игнорирует вычисленное «завтра»)", async () => {
    const { lab } = t;
    lab.connect();
    bill(lab, "2026-07-30T12:00:00");
    await lab.clock.advanceTo("2026-07-29T13:00:00"); // сегодня 29-е, срок 30-го
    const due = lab.spoken().find((s) => s.includes("напоминаю"));
    expect(due).toBeDefined();
    expect(due).not.toContain("сегодня"); // закон 1: не сообщаем ложный факт
  });

  it.skipIf(!DEFECTS)("ДЕФЕКТ: просроченный вчера счёт озвучивается как «сегодня оплатить» вместо «срок прошёл»", async () => {
    const { lab } = t;
    lab.connect();
    await lab.clock.advanceTo("2026-07-30T09:00:00");
    bill(lab, "2026-07-29T12:00:00"); // срок был вчера
    await lab.clock.advance(2 * HOUR);
    expect(lab.spoken()).toHaveLength(1);
    expect(lab.spoken()[0]).not.toContain("сегодня");
  });
});

describe("ежемесячный счёт (15-го числа)", () => {
  const t = useLab({ start: "2026-07-10T09:00:00", tz: "Europe/Moscow", ambientIntervalMs: HOUR });

  it("в каждом месяце: «скоро» 13-го и «в день оплаты» 14-го в полдень, между месяцами тишина", async () => {
    const { lab } = t;
    lab.connect();
    lab.svc.obligations.add(makeObligation({ userId: OWNER, what: "интернет", recurringDay: 15, now: Date.now() })!);
    await lab.clock.advanceTo("2026-08-20T00:00:00");
    expect(at(lab)).toEqual(["07-13 12:00", "07-14 12:00", "08-13 12:00", "08-14 12:00"]);
  });
});

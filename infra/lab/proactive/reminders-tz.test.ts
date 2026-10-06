/**
 * Часовые пояса и календарь для напоминаний: «каждый день в 09:00» обязано остаться 09:00 по часам владельца при переходе
 * на летнее/зимнее время (шаг 23/25 ч), будни - через выходные и границу года, полночь. Пояс задаётся стендом явно.
 */
import { describe, it } from "vitest";
import { remind, remindAt, useLab } from "./helpers.js";
import { expect } from "./kit.js";

const HOUR = 3_600_000;

interface DstCase {
  tz: string;
  from: string; // первый слот 09:00
  until: string;
  local: string[];
  stepsH: number[];
}

const DST: DstCase[] = [
  {
    tz: "Europe/Berlin", from: "2026-03-28", until: "2026-03-31T10:00:00", // 29.03 часы вперёд: сутки = 23 ч
    local: ["2026-03-28 09:00", "2026-03-29 09:00", "2026-03-30 09:00", "2026-03-31 09:00"], stepsH: [23, 24, 24],
  },
  {
    tz: "Europe/Berlin", from: "2026-10-24", until: "2026-10-27T10:00:00", // 25.10 часы назад: сутки = 25 ч
    local: ["2026-10-24 09:00", "2026-10-25 09:00", "2026-10-26 09:00", "2026-10-27 09:00"], stepsH: [25, 24, 24],
  },
  {
    tz: "America/New_York", from: "2026-03-07", until: "2026-03-10T10:00:00",
    local: ["2026-03-07 09:00", "2026-03-08 09:00", "2026-03-09 09:00", "2026-03-10 09:00"], stepsH: [23, 24, 24],
  },
  {
    tz: "America/New_York", from: "2026-10-31", until: "2026-11-03T10:00:00",
    local: ["2026-10-31 09:00", "2026-11-01 09:00", "2026-11-02 09:00", "2026-11-03 09:00"], stepsH: [25, 24, 24],
  },
];

describe.each(DST)("daily 09:00 через смену времени ($tz, с $from)", (c) => {
  const t = useLab({ tz: c.tz, start: `${c.from}T08:00:00` });

  it("звучит в 09:00 по часам владельца каждый день; сутки в день перехода - 23/25 ч", async () => {
    const { lab } = t;
    lab.connect();
    remindAt(lab, "Пить таблетки", `${c.from}T09:00:00`, { kind: "daily" });
    await lab.clock.advanceTo(c.until);
    const times = lab.journal.soundTimes();
    expect(times.map((x) => lab.clock.fmt(x).slice(0, 16))).toEqual(c.local);
    expect(times.slice(1).map((x, i) => (x - times[i]!) / HOUR)).toEqual(c.stepsH);
  });
});

describe("календарь", () => {
  const t = useLab({ tz: "Europe/Moscow", start: "2026-12-31T08:00:00" });

  it("weekdays через конец года: чт 31.12 -> пт 01.01 -> пн 04.01 (выходные молчат)", async () => {
    const { lab } = t;
    lab.connect();
    remindAt(lab, "Отчёт", "2026-12-31T09:00:00", { kind: "weekdays" });
    await lab.clock.advanceTo("2027-01-05T00:00:00");
    expect(lab.journal.soundTimes().map((x) => lab.clock.fmt(x).slice(0, 16))).toEqual(["2026-12-31 09:00", "2027-01-01 09:00", "2027-01-04 09:00"]);
  });

  it("слот 23:59:30: звучит до полуночи, следующий - на следующие сутки в то же время (не после 00:00)", async () => {
    const { lab } = t;
    lab.connect();
    remindAt(lab, "Закрыть смену", "2026-12-31T23:59:30", { kind: "daily" });
    await lab.clock.advanceTo("2027-01-02T00:30:00");
    expect(lab.journal.soundTimes().map((x) => lab.clock.fmt(x))).toEqual(["2026-12-31 23:59:30.000", "2027-01-01 23:59:30.000"]);
  });

  it("weekly: тот же день недели через 7 суток, месяц не мешает", async () => {
    const { lab } = t;
    lab.connect();
    remindAt(lab, "Полить цветы", "2026-12-31T18:00:00", { kind: "weekly" });
    await lab.clock.advanceTo("2027-01-15T00:00:00");
    expect(lab.journal.soundTimes().map((x) => lab.clock.fmt(x).slice(0, 16))).toEqual(["2026-12-31 18:00", "2027-01-07 18:00", "2027-01-14 18:00"]);
  });
});

describe("interval - абсолютный шаг, а не «каждый день»", () => {
  const t = useLab({ tz: "Europe/Berlin", start: "2026-03-28T08:00:00" });

  it("каждые 24 ч через перевод часов: шаг ровно 24 ч, локальный час уезжает на 10:00 (daily остался бы 09:00)", async () => {
    const { lab } = t;
    lab.connect();
    const r = remind(lab, "Замер", HOUR, { kind: "interval", seconds: 24 * 3600 }); // первый слот 09:00 28.03
    await lab.clock.advanceTo("2026-03-30T12:00:00");
    const times = lab.journal.soundTimes();
    expect(times[0]).toBe(r.fireAt);
    expect(times.map((x) => (x - r.fireAt) / HOUR)).toEqual([0, 24, 48]);
    expect(lab.clock.fmt(times[1]!).slice(0, 16)).toBe("2026-03-29 10:00");
  });
});

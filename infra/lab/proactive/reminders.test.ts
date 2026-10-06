/**
 * Напоминания на виртуальных часах через НАСТОЯЩУЮ очередь озвучки: срок, порядок, серии, отмена, пропущенные без пачки.
 * Проверяется момент ЗВУКА (journal.soundTimes), а не вызов speak: «принято в очередь» ≠ «прозвучало».
 */
import { describe, it } from "vitest";
import { OWNER, remind, remindAt, useLab } from "./helpers.js";
import { expect } from "./kit.js";

const HOUR = 3_600_000;

describe("напоминания: срок и порядок", () => {
  const t = useLab();

  it("звучит ровно в срок: за 1 мс до - тишина, в срок - один звук в ту же миллисекунду", async () => {
    const { lab } = t;
    lab.connect();
    const r = remind(lab, "Пора в зал", 5_000);
    await lab.clock.advance(4_999);
    expect(lab.spoken()).toEqual([]);
    await lab.clock.advance(1);
    expect(lab.spoken()).toEqual(["Пора в зал"]);
    expect(lab.journal.soundTimes()).toEqual([r.fireAt]);
    expect(lab.svc.reminders.list(OWNER)).toEqual([]); // доставленное не висит активным
  });

  it("несколько дел: каждое в свой момент, в порядке сроков, не пачкой", async () => {
    const { lab } = t;
    lab.connect();
    const a = remind(lab, "второе дело", 20_000);
    const b = remind(lab, "первое дело", 10_000);
    await lab.clock.advance(60_000);
    expect(lab.spoken()).toEqual(["первое дело", "второе дело"]);
    expect(lab.journal.soundTimes()).toEqual([b.fireAt, a.fireAt]);
  });

  it("отмена до срока: не звучит никогда; чужое дело отмена не трогает", async () => {
    const { lab } = t;
    lab.connect();
    remind(lab, "позвонить маме", 10_000);
    remind(lab, "выпить воды", 10_000);
    expect(lab.svc.reminders.cancel("маме", OWNER)?.text).toBe("позвонить маме");
    await lab.clock.advance(HOUR);
    expect(lab.spoken()).toEqual(["выпить воды"]);
  });
});

describe("напоминания: серии", () => {
  const t = useLab({ start: "2026-07-29T08:00:00" });

  it("daily 09:00: звучит в 09:00 три дня подряд, будущий слот один (без пачки экземпляров)", async () => {
    const { lab } = t;
    lab.connect();
    remindAt(lab, "Пить таблетки", "2026-07-29T09:00:00", { kind: "daily" });
    await lab.clock.advanceTo("2026-08-01T08:00:00");
    expect(lab.journal.soundTimes().map((x) => lab.clock.fmt(x))).toEqual([
      "2026-07-29 09:00:00.000",
      "2026-07-30 09:00:00.000",
      "2026-07-31 09:00:00.000",
    ]);
    const next = lab.svc.reminders.list(OWNER);
    expect(next).toHaveLength(1);
    expect(lab.clock.fmt(next[0]!.fireAt)).toBe("2026-08-01 09:00:00.000");
  });

  it("weekdays: пятница 09:00, дальше понедельник - выходные молчат", async () => {
    const { lab } = t;
    lab.connect();
    remindAt(lab, "Дейли-стендап", "2026-07-31T09:00:00", { kind: "weekdays" }); // 31.07.2026 - пятница
    await lab.clock.advanceTo("2026-08-04T10:00:00");
    expect(lab.journal.soundTimes().map((x) => lab.clock.fmt(x))).toEqual([
      "2026-07-31 09:00:00.000",
      "2026-08-03 09:00:00.000", // понедельник
      "2026-08-04 09:00:00.000",
    ]);
  });

  it("interval 3 ч: шаги ровно по 3 часа", async () => {
    const { lab } = t;
    lab.connect();
    const r = remind(lab, "Размяться", 3 * HOUR, { kind: "interval", seconds: 3 * 3600 });
    await lab.clock.advance(12 * HOUR);
    expect(lab.journal.soundTimes()).toEqual([1, 2, 3, 4].map((k) => r.fireAt + (k - 1) * 3 * HOUR));
  });

  it("отмена серии после первого срабатывания: следующих слотов нет", async () => {
    const { lab } = t;
    lab.connect();
    remindAt(lab, "Зарядка", "2026-07-29T09:00:00", { kind: "daily" });
    await lab.clock.advanceTo("2026-07-29T09:30:00");
    expect(lab.svc.reminders.cancel("зарядка", OWNER)).not.toBeNull();
    await lab.clock.advance(3 * 24 * HOUR);
    expect(lab.spoken()).toEqual(["Зарядка"]);
  });

  it("владелец офлайн 5 часов: серия каждый час при подключении звучит ОДИН раз, а не пачкой из пяти", async () => {
    const { lab } = t;
    remind(lab, "Пить воду", HOUR, { kind: "interval", seconds: 3600 });
    await lab.clock.advance(5 * HOUR + 60_000); // пять срабатываний в тишину
    expect(lab.spoken()).toEqual([]);
    lab.connect();
    await lab.clock.advance(60_000);
    expect(lab.spoken()).toEqual(["Пить воду"]);
  });
});

/**
 * Напоминания и рестарт сервера: durable-состояние на диске - не теряется и не дублируется. Рестарт = новые экземпляры
 * сервисов на том же каталоге (штатный: с дозаписью сторов; крэш: процесса нет, живёт только записанное).
 */
import { describe, it } from "vitest";
import { OWNER, remind, remindAt, useLab } from "./helpers.js";
import { expect } from "./kit.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
type Down = "restart" | "crash";
const kill = (lab: ReturnType<typeof useLab>["lab"], how: Down, downMs = 0): Promise<void> => (how === "crash" ? lab.crash(downMs) : lab.restart(downMs));

describe.each<Down>(["restart", "crash"])("напоминания переживают %s", (how) => {
  const t = useLab({ start: "2026-07-29T08:00:00" });

  it("до срока: не теряется и звучит ровно один раз в срок", async () => {
    const { lab } = t;
    const r = remind(lab, "Созвон с Германом", 10 * MIN);
    await kill(lab, how, 30_000);
    lab.connect();
    await lab.clock.advance(r.fireAt - lab.clock.now());
    expect(lab.spoken()).toEqual(["Созвон с Германом"]);
    expect(lab.journal.soundTimes()).toEqual([r.fireAt]);
    await lab.clock.advance(3 * HOUR);
    expect(lab.spoken()).toHaveLength(1); // не дублируется
  });

  it("сработало в тишину (клиента не было): при подключении после рестарта звучит один раз", async () => {
    const { lab } = t;
    remind(lab, "Выпей воды", MIN);
    await lab.clock.advance(2 * MIN);
    expect(lab.spoken()).toEqual([]); // некому говорить
    await kill(lab, how);
    lab.connect();
    await lab.clock.advance(5_000);
    expect(lab.spoken()).toEqual(["Выпей воды"]);
    await lab.clock.advance(3 * HOUR);
    expect(lab.spoken()).toHaveLength(1);
  });

  it("серия: простой 2 суток 4 часа - «за позавчера» не звучит, следующий 09:00 звучит один раз", async () => {
    const { lab } = t;
    remindAt(lab, "Таблетки", "2026-07-29T09:00:00", { kind: "daily" });
    await kill(lab, how, 2 * 24 * HOUR + 4 * HOUR); // 2026-07-31 12:00, grace 6 ч давно вышел
    lab.connect();
    await lab.clock.advance(MIN);
    expect(lab.spoken()).toEqual([]);
    await lab.clock.advanceTo("2026-08-01T09:30:00");
    expect(lab.journal.soundTimes().map((x) => lab.clock.fmt(x))).toEqual(["2026-08-01 09:00:00.000"]);
  });

  it("простой в пределах grace (1,5 ч): просроченное озвучивается один раз при первом же случае", async () => {
    const { lab } = t;
    remindAt(lab, "Позвонить в банк", "2026-07-29T09:00:00");
    await kill(lab, how, 90 * MIN); // сервер поднялся в 09:30, дело было на 09:00
    await lab.clock.advanceTo("2026-07-29T09:45:00"); // сработало в тишину, владельца ещё нет
    lab.connect();
    await lab.clock.advance(5_000);
    expect(lab.spoken()).toEqual(["Позвонить в банк"]);
  });
});

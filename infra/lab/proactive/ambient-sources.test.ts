/**
 * НАСТОЯЩИЕ ambient-источники (календарь, Telegram) поверх фейковых ридеров вкладок на виртуальных часах и настоящей очереди
 * озвучки: «через 20 минут созвон» в срок и один раз, протухшая фраза не зачитывается, нет вкладки - тишина без падений.
 */
import { afterEach, describe, it } from "vitest";
import { createCalendarSource } from "../../../apps/server/src/proactive/ambient/calendar-source.js";
import { createTelegramSource } from "../../../apps/server/src/proactive/ambient/telegram-source.js";
import { OWNER, useLab } from "./helpers.js";
import { expect } from "./kit.js";

const MIN = 60_000;
const now = (): number => Date.now(); // источники берут Date.now по ссылке при создании, а фейковые часы ставит стенд позже
/** Что «показывают вкладки» сейчас; тесты меняют. */
const tabs: { calendar: unknown; telegram: unknown; throws: boolean } = { calendar: { noTab: true }, telegram: { noTab: true }, throws: false };
const reader = <T>(pick: () => T) => async (): Promise<T> => {
  if (tabs.throws) throw new Error("расширение не подключено");
  return pick();
};
const event = (title: string, from: string, to: string): unknown => ({ ok: true, events: [{ label: `${title}, ${from} – ${to}, 29 июля 2026 г.` }] });
const chat = (title: string, preview: string, count = 1): unknown => ({ ok: true, unread: [{ title, preview, count }] });

describe("ambient-источники из вкладок", () => {
  const t = useLab({
    start: "2026-07-29T09:00:00",
    tz: "Europe/Moscow",
    ambientIntervalMs: MIN,
    extraSources: [
      createCalendarSource({ calendarRead: reader(() => tabs.calendar) }, OWNER, { now }),
      createTelegramSource({ telegramUnread: reader(() => tabs.telegram) }, OWNER, { now }),
    ],
  });
  afterEach(() => {
    // после теста, а не до: beforeEach стенда уже поднял ambient, и его первый тик прочёл бы «вчерашние» вкладки
    tabs.calendar = { noTab: true };
    tabs.telegram = { noTab: true };
    tabs.throws = false;
  });
  const at = (lab: typeof t.lab): string[] => lab.journal.soundTimes().map((x) => lab.clock.fmt(x).slice(11, 19));

  it("встреча в 10:00: предупреждение при входе в окно 20 минут (09:40:00) и один раз", async () => {
    const { lab } = t;
    lab.connect();
    tabs.calendar = event("Созвон с командой", "10:00", "11:00");
    await lab.clock.advanceTo("2026-07-29T09:39:59");
    expect(lab.spoken()).toEqual([]);
    await lab.clock.advanceTo("2026-07-29T10:30:00");
    expect(at(lab)).toEqual(["09:40:00"]);
    expect(lab.spoken()[0]).toContain("Созвон с командой");
  });

  it("владелец подключился, когда фраза «через двадцать минут» уже протухла: слышит свежую «через пять», а не устаревшую", async () => {
    const { lab } = t;
    tabs.calendar = event("Созвон с командой", "10:00", "11:00");
    await lab.clock.advanceTo("2026-07-29T09:55:00"); // сигнал родился в 09:40 и лежит в pending, фраза давно протухла
    lab.connect();
    await lab.clock.advance(3 * MIN);
    expect(lab.spoken()).toHaveLength(1);
    expect(lab.spoken()[0]).toContain("пять");
    expect(lab.spoken()[0]).not.toContain("двадцать");
  });

  it("Telegram: непрочитанное - один раз; то же без нового сообщения не повторяется; новое сообщение - новое уведомление", async () => {
    const { lab } = t;
    lab.connect();
    tabs.telegram = chat("Герман", "Ты где?");
    await lab.clock.advance(10 * MIN);
    expect(lab.spoken()).toHaveLength(1);
    expect(lab.spoken()[0]).toContain("Герман");
    tabs.telegram = chat("Герман", "Алло?", 2);
    await lab.clock.advance(3 * MIN);
    expect(lab.spoken()).toHaveLength(2);
    await lab.clock.advance(HOUR());
    expect(lab.spoken()).toHaveLength(2);
  });

  it("нет вкладки / расширение отвалилось: тишина, движок жив, потом вернулось - заговорил", async () => {
    const { lab } = t;
    lab.connect();
    tabs.throws = true;
    await lab.clock.advance(10 * MIN);
    tabs.throws = false;
    tabs.telegram = { noTab: true };
    await lab.clock.advance(10 * MIN);
    expect(lab.spoken()).toEqual([]);
    tabs.telegram = chat("Мария", "Привет");
    await lab.clock.advance(2 * MIN);
    expect(lab.spoken()).toHaveLength(1);
  });
});

function HOUR(): number {
  return 60 * MIN;
}

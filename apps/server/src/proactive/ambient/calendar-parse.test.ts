/**
 * Разбор чипов календаря (D-4). Тестируем ЧИСТОЕ ядро — оно и есть место, где рождается ложь
 * «встреча в 15:00», если распарсили не то. Живой DOM Chrome тут не нужен.
 */
import { describe, expect, it } from "vitest";
import { extractDate, extractTimeOfDay, extractTitle, parseCalendarChips, upcomingEvents } from "./calendar-parse.js";

const NOW = new Date(2026, 6, 29, 12, 0, 0).getTime(); // 29 июля 2026, среда, полдень (локально)
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi, 0, 0).getTime();

describe("extractTimeOfDay", () => {
  it("24-часовой и am/pm", () => {
    expect(extractTimeOfDay("Созвон, 15:00 – 16:00")).toMatchObject({ h: 15, m: 0 });
    expect(extractTimeOfDay("Team sync, 3:30pm – 4:00pm")).toMatchObject({ h: 15, m: 30 });
    expect(extractTimeOfDay("Standup, 9 am")).toMatchObject({ h: 9, m: 0 });
    expect(extractTimeOfDay("Late, 12:15 a.m.")).toMatchObject({ h: 0, m: 15 });
  });

  it("меридием у конца диапазона распространяется на начало («3:00 – 4:00pm» = 15:00)", () => {
    expect(extractTimeOfDay("Team sync, 3:00 – 4:00pm")).toMatchObject({ h: 15, m: 0 });
    // …но не когда это перевернуло бы диапазон: «11:00 – 1:00pm» — это 11 УТРА.
    expect(extractTimeOfDay("Обед, 11:00 – 1:00pm")).toMatchObject({ h: 11, m: 0 });
    // 24-часовая запись без меридиема не трогается.
    expect(extractTimeOfDay("Созвон, 15:00 – 16:00")).toMatchObject({ h: 15, m: 0 });
  });

  it("голое число временем НЕ считается (иначе «Совет 5» станет пятью часами)", () => {
    expect(extractTimeOfDay("Совет 5")).toBeNull();
    expect(extractTimeOfDay("Спринт 12")).toBeNull();
  });

  it("мусорное время отвергается", () => {
    expect(extractTimeOfDay("версия 45:99")).toBeNull();
  });
});

describe("extractDate", () => {
  it("русские и английские формы, с годом и без", () => {
    expect(extractDate("29 июля 2026 г.")).toEqual({ day: 29, month: 6, year: 2026 });
    expect(extractDate("1 мая")).toEqual({ day: 1, month: 4, year: undefined });
    expect(extractDate("July 29, 2026")).toEqual({ day: 29, month: 6, year: 2026 });
    expect(extractDate("Jul 4")).toEqual({ day: 4, month: 6, year: undefined });
    expect(extractDate("29.07.2026")).toEqual({ day: 29, month: 6, year: 2026 });
  });

  it("нет даты → null (не выдумываем)", () => {
    expect(extractDate("Созвон с командой")).toBeNull();
  });
});

describe("extractTitle", () => {
  it("формат Google: название до времени", () => {
    expect(extractTitle("Созвон с командой, 15:00 – 16:00, 29 июля 2026 г.")).toBe("Созвон с командой");
    expect(extractTitle("Team sync, 3:00 – 4:00pm, July 29, 2026")).toBe("Team sync");
  });

  it("запятая внутри названия не режет его, если дальше не время", () => {
    expect(extractTitle("Разбор, потом обед")).toBe("Разбор, потом обед");
  });

  it("ведущее время срезается", () => {
    expect(extractTitle("15:00 Планёрка")).toBe("Планёрка");
  });

  // КОНТРОЛЬ-4 (MEDIUM): срез «всё до конца времени, если оно в первых 24 символах» на КОРОТКОМ
  // названии выкусывал ХВОСТ диапазона — названием становилось «10:15»/«16:00»/«10am», а ключ дедупа
  // `startAt|title` схлопывал РАЗНЫЕ встречи в одну молча.
  it("название берётся ДО времени, а не хвост диапазона (чип без запятых — textContent)", () => {
    expect(extractTitle("Стендап команды 10:00 – 10:15")).toBe("Стендап команды");
    expect(extractTitle("Планёрка 15:00 – 16:00")).toBe("Планёрка");
    expect(extractTitle("Планёрка 9 – 10am")).toBe("Планёрка");
    expect(extractTitle("Ретроспектива спринта 15:00 – 16:00")).toBe("Ретроспектива спринта");
  });

  // КОНТРОЛЬ-5 (MEDIUM): фикс закрыл только «название ПЕРЕД временем». Когда метка НАЧИНАЕТСЯ с
  // диапазона, в название утекал его КОНЕЦ — владельцу называли два времени одной встречи
  // («через 20 мин — 11:00 Ретро (в 10:00)»).
  it("метка начинается с ДИАПАЗОНА — срезается весь диапазон, не только первое время", () => {
    expect(extractTitle("10:00 – 11:00 Ретро")).toBe("Ретро");
    expect(extractTitle("10:00–11:00 Ретро")).toBe("Ретро");
    expect(extractTitle("9:00 - 9:15 Стендап")).toBe("Стендап");
    expect(extractTitle("13:30 – 14:30, Обед с Катей")).toBe("Обед с Катей");
    expect(extractTitle("9 – 10am Standup")).toBe("Standup");
    expect(extractTitle("3:00 – 4:00pm Демо")).toBe("Демо");
    expect(extractTitle("15:00 – 16:00 Созвон с командой")).toBe("Созвон с командой");
  });

  it("метка БЕЗ названия (одно время) отдаётся как есть — выдумывать название нечестно", () => {
    expect(extractTitle("9 – 10am")).toBe("9 – 10am");
    expect(extractTitle("15:00")).toBe("15:00");
  });

  it("две РАЗНЫЕ встречи в одном слоте не схлопываются в одну", () => {
    const r = parseCalendarChips(
      [
        { label: "Стендап команды 10:00 – 10:15", today: true },
        { label: "Груминг бэклога 10:00 – 10:15", today: true },
      ],
      NOW,
    );
    expect(r.events.map((e) => e.title).sort()).toEqual(["Груминг бэклога", "Стендап команды"]);
  });
});

describe("parseCalendarChips — момент времени или честный unparsed", () => {
  it("полная метка Google (RU) → точный момент", () => {
    const r = parseCalendarChips([{ label: "Созвон с командой, 15:00 – 16:00, 29 июля 2026 г." }], NOW);
    expect(r.unparsed).toBe(0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toEqual({ title: "Созвон с командой", startAt: at(2026, 6, 29, 15), allDay: false });
  });

  it("полная метка Google (EN) → тот же результат", () => {
    const r = parseCalendarChips([{ label: "Team sync, 3:00 – 4:00pm, July 29, 2026" }], NOW);
    expect(r.events[0]).toMatchObject({ title: "Team sync", startAt: at(2026, 6, 29, 15) });
  });

  it("год не назван → берётся БЛИЖАЙШИЙ к сегодня (декабрьский календарь не отправляет январь в прошлое)", () => {
    const dec = new Date(2026, 11, 28, 10, 0, 0).getTime();
    const r = parseCalendarChips([{ label: "Планёрка, 10:00, 5 января" }], dec);
    expect(r.events[0]!.startAt).toBe(at(2027, 0, 5, 10));
  });

  it("ЧЕСТНОСТЬ: без даты и без доказанного «сегодня» событие НЕ приписывается сегодняшнему дню", () => {
    const r = parseCalendarChips([{ label: "Созвон, 15:00" }], NOW);
    expect(r.events).toHaveLength(0);
    expect(r.unparsed).toBe(1);
  });

  it("чип из колонки «сегодня» без даты — берём сегодняшний день", () => {
    const r = parseCalendarChips([{ label: "Созвон, 15:00", today: true }], NOW);
    expect(r.events[0]!.startAt).toBe(at(2026, 6, 29, 15));
  });

  it("дата приходит из подписи дня-контейнера", () => {
    const r = parseCalendarChips([{ label: "Созвон, 15:00", day: "30 июля 2026 г." }], NOW);
    expect(r.events[0]!.startAt).toBe(at(2026, 6, 30, 15));
  });

  it("событие на весь день: дата есть, времени нет → полночь + allDay", () => {
    const r = parseCalendarChips([{ label: "Отпуск, 3 августа 2026 г." }], NOW);
    expect(r.events[0]).toMatchObject({ startAt: at(2026, 7, 3, 0), allDay: true });
  });

  it("невозможная дата (31 июня) не превращается в 1 июля — уходит в unparsed", () => {
    const r = parseCalendarChips([{ label: "Сдача, 10:00, 31 июня 2026" }], NOW);
    expect(r.events).toHaveLength(0);
    expect(r.unparsed).toBe(1);
  });

  it("дубль чипа (сетка + список) схлопывается, порядок — по времени", () => {
    const r = parseCalendarChips(
      [
        { label: "Обед, 13:00, 29 июля 2026 г." },
        { label: "Созвон, 15:00, 29 июля 2026 г." },
        { label: "Созвон, 15:00, 29 июля 2026 г." },
      ],
      NOW,
    );
    expect(r.events.map((e) => e.title)).toEqual(["Обед", "Созвон"]);
  });

  it("пустые метки игнорируются молча (это не событие и не сбой разбора)", () => {
    const r = parseCalendarChips([{ label: "   " }, { label: "" }], NOW);
    expect(r.events).toHaveLength(0);
    expect(r.unparsed).toBe(0);
  });
});

// ФИНАЛЬНОЕ РЕВЬЮ (HIGH): префиксный матч месяца по ЛЮБОМУ слову метки давал УВЕРЕННО НЕВЕРНУЮ дату
// (unparsed=0, деградация молчала) — «Q3 Marketing» становилось 3 марта. Ложный факт хуже отсутствия.
describe("названия событий не превращаются в даты", () => {
  const cases: Array<[string, string]> = [
    ["Q3 Marketing, 15:00, 29 июля 2026 г.", "Marketing ≠ март"],
    ["Sprint 5 decisions, 15:00, 29 июля 2026 г.", "decisions ≠ декабрь"],
    ["Q1 итоги, 15:00 – 16:00, 29 июля 2026 г.", "первое совпадение не должно глушить разбор"],
    ["Разбор 9 Майоров, 09:15, 30 июля 2026 г.", "фамилия Майоров ≠ май"],
    ["Звонок с Julia 4, 15:00, 29 июля 2026 г.", "Julia ≠ July"],
    ["Планёрка Мартынова, 15:00, 29 июля 2026 г.", "Мартынов ≠ март"],
  ];
  for (const [label, why] of cases) {
    it(`${why}: «${label.slice(0, 28)}…» разбирается по НАСТОЯЩЕЙ дате`, () => {
      const r = parseCalendarChips([{ label }], NOW);
      expect(r.events).toHaveLength(1);
      const d = new Date(r.events[0]!.startAt);
      expect(d.getMonth()).toBe(6); // июль — из хвоста метки, а не из названия
      expect([29, 30]).toContain(d.getDate());
    });
  }

  it("день не выкусывается из года («июля 2026» ≠ 20 июля)", () => {
    expect(extractDate("Q1 итоги, 15:00, 29 июля 2026 г.")).toEqual({ day: 29, month: 6, year: 2026 });
  });

  it("ISO из data-date контейнера понимается", () => {
    expect(extractDate("2026-07-29")).toEqual({ day: 29, month: 6, year: 2026 });
  });

  // КОНТРОЛЬ-4 (HIGH): числовая ветка выкусывала дату из версии/десятичного числа в НАЗВАНИИ —
  // «Демо v1.2» становилось 1 февраля, и unparsed при этом оставался 0 (деградация молчала).
  it("номера версий и десятичные числа в названии датой НЕ становятся", () => {
    expect(extractDate("Демо v1.2")).toBeNull();
    expect(extractDate("Release 2.1 review")).toBeNull();
    expect(extractDate("Оплата 3.5 тыс")).toBeNull();
    expect(extractDate("29.07")).toBeNull(); // без года — неоднозначно, честнее не угадывать
  });

  it("числовая дата С ГОДОМ по-прежнему понимается", () => {
    expect(extractDate("29.07.2026")).toEqual({ day: 29, month: 6, year: 2026 });
    expect(extractDate("29/07/26")).toEqual({ day: 29, month: 6, year: 2026 });
  });

  it("версия в названии не перебивает достоверную дату контейнера", () => {
    const r = parseCalendarChips([{ label: "Релиз 1.2, 15:00 – 16:00", day: "2026-07-29", today: true }], NOW);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.startAt).toBe(at(2026, 6, 29, 15));
    expect(r.events[0]!.title).toBe("Релиз 1.2");
  });

  it("месяц целым словом всё ещё узнаётся во всех обычных формах", () => {
    expect(extractDate("29 июля")).toMatchObject({ month: 6 });
    expect(extractDate("1 марта")).toMatchObject({ month: 2 });
    expect(extractDate("3 мая")).toMatchObject({ month: 4 });
    expect(extractDate("Dec 3")).toMatchObject({ month: 11 });
    expect(extractDate("March 3")).toMatchObject({ month: 2 });
  });
});

// ФИНАЛЬНОЕ РЕВЬЮ (MEDIUM): компактный диапазон «9 – 10am» отдавал КОНЕЦ за начало.
describe("компактный англоязычный диапазон без минут", () => {
  it("«9 – 10am» = 9:00, а не 10:00", () => {
    expect(extractTimeOfDay("Стендап, 9 – 10am")).toMatchObject({ h: 9, m: 0 });
  });

  it("«12 – 1pm» = 12:00 (меридием конца не переворачивает диапазон)", () => {
    expect(extractTimeOfDay("Обед, 12 – 1pm")).toMatchObject({ h: 12, m: 0 });
  });

  it("«2 – 3pm» = 14:00", () => {
    expect(extractTimeOfDay("Созвон, 2 – 3pm")).toMatchObject({ h: 14, m: 0 });
  });

  it("одиночное «3pm» по-прежнему 15:00", () => {
    expect(extractTimeOfDay("Созвон, 3pm")).toMatchObject({ h: 15, m: 0 });
  });
});

describe("upcomingEvents — окно «через сколько-то минут»", () => {
  it("берёт только будущее в пределах окна", () => {
    const evs = [
      { title: "Прошлое", startAt: NOW - 60_000, allDay: false },
      { title: "Скоро", startAt: NOW + 15 * 60_000, allDay: false },
      { title: "Нескоро", startAt: NOW + 5 * 3600_000, allDay: false },
    ];
    expect(upcomingEvents(evs, NOW, 20 * 60_000).map((e) => e.title)).toEqual(["Скоро"]);
  });
});

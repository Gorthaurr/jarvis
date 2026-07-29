/**
 * Сводка дня (волна D). Главные требования — ЧЕСТНОСТЬ (нечего сказать → молчим, а не «всё спокойно»)
 * и КРАТКОСТЬ (голос не терпит списков: 3 пункта + «и ещё N»). Плюс гейт «раз в календарный день».
 */
import { describe, expect, it } from "vitest";
import { buildBriefing, sameLocalDay, shouldBrief } from "./briefing.js";

const at = (iso: string) => new Date(iso).getTime();
const NOW = at("2026-07-29T08:00:00");
const empty = { reminders: [], obligations: [], watches: [] };

describe("buildBriefing — сводка дня", () => {
  it("нечего сказать → null (никаких «сегодня всё спокойно, сэр»)", () => {
    expect(buildBriefing(empty, NOW)).toBeNull();
  });

  // D-4: встречи из календаря — самое жёсткое обязательство дня, идут первыми.
  it("сегодняшние встречи попадают в сводку ПЕРВЫМ пунктом", () => {
    const line = buildBriefing(
      {
        ...empty,
        events: [{ startAt: at("2026-07-29T15:00:00"), title: "Созвон с командой" }],
        reminders: [{ fireAt: at("2026-07-29T19:00:00"), text: "полить кактус" }],
      },
      NOW,
    )!;
    expect(line.indexOf("Встречи")).toBeLessThan(line.indexOf("На сегодня"));
    expect(line).toContain("в 15:00 — Созвон с командой");
  });

  it("прошедшая и завтрашняя встречи в сводку дня не идут", () => {
    expect(
      buildBriefing({ ...empty, events: [{ startAt: at("2026-07-29T07:00:00"), title: "Ранняя" }] }, NOW),
    ).toBeNull();
    expect(
      buildBriefing({ ...empty, events: [{ startAt: at("2026-07-30T10:00:00"), title: "Завтрашняя" }] }, NOW),
    ).toBeNull();
  });

  it("событие «весь день» называется без часов и не отсекается тем, что 00:00 уже прошло", () => {
    const line = buildBriefing(
      { ...empty, events: [{ startAt: at("2026-07-29T00:00:00"), title: "Отпуск", allDay: true }] },
      NOW,
    )!;
    expect(line).toContain("весь день — Отпуск");
  });

  it("календарь не прочитан (events отсутствует) — сводка собирается по остальным источникам", () => {
    const line = buildBriefing({ ...empty, reminders: [{ fireAt: at("2026-07-29T19:00:00"), text: "зал" }] }, NOW)!;
    expect(line).toContain("На сегодня");
    expect(line).not.toContain("Встречи");
  });

  it("напоминания на СЕГОДНЯ попадают со временем; прошедшие и завтрашние — нет", () => {
    const line = buildBriefing(
      {
        ...empty,
        reminders: [
          { fireAt: at("2026-07-29T07:00:00"), text: "уже прошло" },
          { fireAt: at("2026-07-29T15:00:00"), text: "созвон с командой" },
          { fireAt: at("2026-07-30T10:00:00"), text: "это завтра" },
        ],
      },
      NOW,
    )!;
    expect(line).toContain("15:00");
    expect(line).toContain("созвон с командой");
    expect(line).not.toContain("уже прошло");
    expect(line).not.toContain("это завтра");
  });

  it("длинный список схлопывается: 3 пункта + «и ещё N»", () => {
    const reminders = Array.from({ length: 6 }, (_, i) => ({
      fireAt: at(`2026-07-29T1${i}:00:00`),
      text: `дело ${i}`,
    }));
    const line = buildBriefing({ ...empty, reminders }, NOW)!;
    expect(line).toContain("и ещё 3");
    expect(line).toContain("дело 0");
    expect(line).not.toContain("дело 5"); // хвост не зачитываем
  });

  it("сроки обязательств: сегодня и завтра, с указанием когда", () => {
    const line = buildBriefing(
      {
        ...empty,
        obligations: [
          { dueAt: at("2026-07-29T12:00:00"), title: "интернет" },
          { dueAt: at("2026-07-30T12:00:00"), title: "аренда" },
          { dueAt: at("2026-08-15T12:00:00"), title: "далёкий счёт" },
        ],
      },
      NOW,
    )!;
    expect(line).toContain("интернет — сегодня");
    expect(line).toContain("аренда — завтра");
    expect(line).not.toContain("далёкий счёт");
  });

  // РЕВЬЮ ВОЛНЫ D (HIGH): бинарная метка «сегодня/завтра» называла ПРОСРОЧЕННОЕ обязательство
  // «завтра» — прямая ложь, повторявшаяся каждый день, пока владелец не оплатит.
  it("просроченный срок называется ЧЕСТНО, а не «завтра»", () => {
    const line = buildBriefing(
      { ...empty, obligations: [{ dueAt: at("2026-07-27T12:00:00"), title: "интернет" }] }, // позавчера
      NOW,
    )!;
    expect(line).toContain("интернет — срок уже прошёл");
    expect(line).not.toContain("завтра");
  });

  it("древнее (старше недели) в сводку дня не тянем — это уже не «коротко по дню»", () => {
    const line = buildBriefing(
      { ...empty, obligations: [{ dueAt: at("2026-06-01T12:00:00"), title: "забытый счёт" }] },
      NOW,
    );
    expect(line).toBeNull();
  });

  it("наблюдения: одно называется, много — числом + пример", () => {
    const one = buildBriefing({ ...empty, watches: [{ what: "курс биткоина" }] }, NOW)!;
    expect(one).toContain("Слежу за: курс биткоина");
    const many = buildBriefing(
      { ...empty, watches: [{ what: "курс биткоина" }, { what: "статус заказа" }, { what: "погода" }] },
      NOW,
    )!;
    expect(many).toContain("3");
    expect(many).toContain("курс биткоина");
  });
});

describe("shouldBrief — раз в календарный день", () => {
  it("никогда не брифинговали → пора", () => {
    expect(shouldBrief({}, NOW)).toBe(true);
  });

  it("сегодня уже брифинговали → не повторяем на каждом коннекте", () => {
    expect(shouldBrief({ lastBriefedAt: at("2026-07-29T06:30:00") }, NOW)).toBe(false);
  });

  it("вчерашний брифинг новому дню не мешает", () => {
    expect(shouldBrief({ lastBriefedAt: at("2026-07-28T23:59:00") }, NOW)).toBe(true);
  });

  it("выключатель JARVIS_BRIEFING=0", () => {
    const prev = process.env.JARVIS_BRIEFING;
    process.env.JARVIS_BRIEFING = "0";
    try {
      expect(shouldBrief({}, NOW)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.JARVIS_BRIEFING;
      else process.env.JARVIS_BRIEFING = prev;
    }
  });
});

describe("sameLocalDay", () => {
  it("сравнивает календарные сутки локально, не UTC-окно 24ч", () => {
    expect(sameLocalDay(at("2026-07-29T00:10:00"), at("2026-07-29T23:50:00"))).toBe(true);
    expect(sameLocalDay(at("2026-07-29T23:50:00"), at("2026-07-30T00:10:00"))).toBe(false);
  });
});

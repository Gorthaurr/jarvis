import { describe, expect, it } from "vitest";
import {
  describeRepeat,
  describeWhen,
  nextFireAfter,
  parseRepeat,
  resolveFireAt,
  sameReminderSubject,
  sameSeriesSlot,
} from "./reminder.js";

const NOW = Date.parse("2026-06-18T12:00:00Z");

describe("resolveFireAt — сервер считает абсолютный момент", () => {
  it("delay_seconds → now + N сек", () => {
    expect(resolveFireAt({ delaySeconds: 15 }, NOW)).toEqual({ fireAt: NOW + 15_000 });
    expect(resolveFireAt({ delaySeconds: 600 }, NOW)).toEqual({ fireAt: NOW + 600_000 });
  });

  it("at (ISO, будущее) → распарсенный момент", () => {
    const res = resolveFireAt({ at: "2026-06-18T13:00:00Z" }, NOW);
    expect(res).toEqual({ fireAt: Date.parse("2026-06-18T13:00:00Z") });
  });

  it("ошибки: пусто / оба / <1 / прошлое / кривой ISO", () => {
    expect("error" in resolveFireAt({}, NOW)).toBe(true);
    expect("error" in resolveFireAt({ delaySeconds: 10, at: "2026-06-18T13:00:00Z" }, NOW)).toBe(true);
    expect("error" in resolveFireAt({ delaySeconds: 0 }, NOW)).toBe(true);
    expect("error" in resolveFireAt({ at: "2020-01-01T00:00:00Z" }, NOW)).toBe(true); // прошлое
    expect("error" in resolveFireAt({ at: "не дата" }, NOW)).toBe(true);
  });

  it("слишком далеко (> года) → ошибка", () => {
    expect("error" in resolveFireAt({ delaySeconds: 400 * 24 * 3600 }, NOW)).toBe(true);
  });
});

describe("describeWhen — человеко-описание для подтверждения", () => {
  it("секунды/минуты/часы/дни", () => {
    expect(describeWhen(NOW + 15_000, NOW)).toBe("через 15 сек");
    expect(describeWhen(NOW + 120_000, NOW)).toBe("через 2 мин");
    expect(describeWhen(NOW + 2 * 3600_000, NOW)).toBe("через 2 ч");
    expect(describeWhen(NOW + 3 * 24 * 3600_000, NOW)).toBe("через 3 дн");
  });
});

// ── ВОЛНА D: повторяющиеся напоминания («напоминай каждый день пить таблетки») ──────────────────
// Раньше Reminder был СТРОГО одноразовым. Здесь фиксируются честностные грани серии: пропущенные
// слоты не звучат пачкой, локальное время суток не уезжает, мусорный ритм — честный отказ.

const local = (iso: string) => new Date(iso).getTime(); // локальная зона (сервер = ПК владельца)
const hhmm = (ts: number) => `${new Date(ts).getHours()}:${String(new Date(ts).getMinutes()).padStart(2, "0")}`;

describe("parseRepeat — ритм повтора", () => {
  it("словесные ритмы (вкл. русские) и числовой интервал", () => {
    expect(parseRepeat("daily")).toEqual({ repeat: { kind: "daily" } });
    expect(parseRepeat("каждый день")).toEqual({ repeat: { kind: "daily" } });
    expect(parseRepeat("будни")).toEqual({ repeat: { kind: "weekdays" } });
    expect(parseRepeat("weekly")).toEqual({ repeat: { kind: "weekly" } });
    expect(parseRepeat(10_800)).toEqual({ repeat: { kind: "interval", seconds: 10_800 } });
  });

  it("пусто → одноразовое (прежнее поведение не меняется)", () => {
    expect(parseRepeat(undefined)).toEqual({});
    expect(parseRepeat("")).toEqual({});
  });

  it("мусор/слишком частый/слишком редкий → ЧЕСТНЫЙ отказ, а не тихое одноразовое", () => {
    expect("error" in parseRepeat("каждое полнолуние")).toBe(true);
    expect("error" in parseRepeat(5)).toBe(true); // чаще минуты = будильник-спам
    expect("error" in parseRepeat(400 * 24 * 3600)).toBe(true); // больше года
    expect("error" in parseRepeat({ kind: "daily" })).toBe(true); // объект не принимаем
  });
});

describe("nextFireAfter — следующее срабатывание серии", () => {
  it("daily: то же время суток на следующий день", () => {
    const prev = local("2026-07-29T09:00:00");
    const next = nextFireAfter({ kind: "daily" }, prev, prev + 1000)!;
    expect(new Date(next).getDate()).toBe(30);
    expect(hhmm(next)).toBe("9:00"); // календарный сдвиг: перевод часов не уносит «в 9 утра»
  });

  it("ПРОПУЩЕННЫЕ слоты НЕ копятся: ПК был выключен трое суток → ОДНО ближайшее будущее срабатывание", () => {
    const prev = local("2026-07-29T09:00:00");
    const now = local("2026-08-01T15:00:00");
    const next = nextFireAfter({ kind: "daily" }, prev, now)!;
    expect(next).toBeGreaterThan(now);
    expect(new Date(next).getDate()).toBe(2); // 2 августа 9:00 — не три «вчерашних» подряд
    expect(hhmm(next)).toBe("9:00");
  });

  it("weekdays: пятница → понедельник (выходные пропускаются)", () => {
    const friday = local("2026-07-31T09:00:00");
    expect(new Date(friday).getDay()).toBe(5);
    const next = nextFireAfter({ kind: "weekdays" }, friday, friday + 1000)!;
    expect(new Date(next).getDay()).toBe(1);
    expect(hhmm(next)).toBe("9:00");
  });

  it("weekly: тот же день недели и то же время", () => {
    const prev = local("2026-07-29T18:30:00");
    const next = nextFireAfter({ kind: "weekly" }, prev, prev + 1000)!;
    expect(new Date(next).getDay()).toBe(new Date(prev).getDay());
    expect(hhmm(next)).toBe("18:30");
  });

  it("interval: догоняет ОДНИМ прыжком (десять пропущенных часов ≠ десять напоминаний)", () => {
    const prev = local("2026-07-29T09:00:00");
    const now = prev + 10 * 3600_000 + 5_000;
    const next = nextFireAfter({ kind: "interval", seconds: 3600 }, prev, now)!;
    expect(next).toBeGreaterThan(now);
    expect(next - prev).toBe(11 * 3600_000);
  });

  it("без правила → null (одноразовое серию не порождает)", () => {
    expect(nextFireAfter(undefined, NOW, NOW)).toBeNull();
  });
});

// Живой смоук волны D поймал дубль: рефлекс обязательств и основная петля, услышав ОДНУ реплику,
// поставили два напоминания об одном деле («Напоминаю: позвонить маме» 10:00 и «Позвонить маме, сэр»
// 11:00) — владелец получил бы два звонка. Точная идемпотентность (текст+время) это не ловит.
describe("sameReminderSubject — про одно ли это дело", () => {
  it("разные формулировки одного дела считаются одним", () => {
    expect(sameReminderSubject("Напоминаю: позвонить маме и поздравить её!", "Позвонить маме и поздравить её, сэр.")).toBe(true);
    expect(sameReminderSubject("Пора принять таблетки", "Напоминаю: принять таблетки")).toBe(true);
  });

  it("разные дела остаются разными (не глушим лишнее)", () => {
    expect(sameReminderSubject("позвонить маме", "позвонить врачу")).toBe(false);
    expect(sameReminderSubject("оплатить кредит", "забрать посылку")).toBe(false);
    expect(sameReminderSubject("сходить в зал", "купить молоко")).toBe(false);
  });

  it("пустое/служебное не склеивает всё подряд", () => {
    expect(sameReminderSubject("", "позвонить маме")).toBe(false);
    expect(sameReminderSubject("сэр", "напоминаю")).toBe(false);
  });
});

// РЕВЬЮ ВОЛНЫ D (HIGH): слот серии — это ВРЕМЯ СУТОК, а не только текст+ритм.
describe("sameSeriesSlot — один ли это слот серии", () => {
  it("то же время суток (другой день) — один слот; другое время — РАЗНЫЕ серии", () => {
    const nine = local("2026-07-29T09:00:00");
    expect(sameSeriesSlot({ kind: "daily" }, nine, local("2026-07-30T09:00:00"))).toBe(true);
    expect(sameSeriesSlot({ kind: "daily" }, nine, local("2026-07-29T21:00:00"))).toBe(false); // утро ≠ вечер
  });

  it("weekly различает и день недели", () => {
    const wed = local("2026-07-29T09:00:00"); // среда
    expect(sameSeriesSlot({ kind: "weekly" }, wed, local("2026-08-05T09:00:00"))).toBe(true); // тоже среда
    expect(sameSeriesSlot({ kind: "weekly" }, wed, local("2026-07-30T09:00:00"))).toBe(false); // четверг
  });

  it("interval сравнивает фазу сетки", () => {
    const base = local("2026-07-29T09:00:00");
    const rule = { kind: "interval", seconds: 3600 } as const;
    expect(sameSeriesSlot(rule, base, base + 3 * 3600_000)).toBe(true); // та же сетка
    expect(sameSeriesSlot(rule, base, base + 30 * 60_000)).toBe(false); // сдвиг на полчаса — другая
  });
});

describe("parseRepeat — устойчивость к тому, что реально шлёт модель", () => {
  it("null/пусто трактуются как «повтора нет» (иначе одноразовое напоминание не создавалось бы)", () => {
    expect(parseRepeat(null)).toEqual({});
    expect(parseRepeat(undefined)).toEqual({});
    expect(parseRepeat("")).toEqual({});
  });
});

describe("describeRepeat — подтверждение владельцу человеческим языком", () => {
  it("ритмы называются по-русски", () => {
    expect(describeRepeat({ kind: "daily" })).toBe("каждый день");
    expect(describeRepeat({ kind: "weekdays" })).toBe("по будням");
    expect(describeRepeat({ kind: "weekly" })).toBe("каждую неделю");
    expect(describeRepeat({ kind: "interval", seconds: 10_800 })).toBe("каждые 3 ч");
    expect(describeRepeat({ kind: "interval", seconds: 900 })).toBe("каждые 15 мин");
    expect(describeRepeat(undefined)).toBe("");
  });
});

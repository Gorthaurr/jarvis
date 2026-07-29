/**
 * Ambient-источник календаря (D-4). Главное, что проверяем — ЧЕСТНОСТЬ границ:
 * «вкладки нет», «вкладка выгружена», «разметку не узнал» и «встреч нет» — четыре РАЗНЫХ исхода,
 * и три из них не имеют права выглядеть как спокойный день.
 */
import { describe, expect, it, vi } from "vitest";
import { createCalendarSource, eventSignal, inMinutesPhrase } from "./calendar-source.js";

const NOW = new Date(2026, 6, 29, 12, 0, 0).getTime();
const at = (h: number, mi = 0) => new Date(2026, 6, 29, h, mi, 0, 0).getTime();

function sourceOf(reply: unknown, opts: { now?: () => number } = {}) {
  const reader = { calendarRead: vi.fn(async () => reply) };
  const src = createCalendarSource(reader, "u1", { now: opts.now ?? (() => NOW), leadMs: 20 * 60_000 });
  return { src, reader };
}

describe("createCalendarSource — что попадает в проактив", () => {
  it("встреча в пределах окна → сигнал с временем и названием", async () => {
    const { src } = sourceOf({ ok: true, events: [{ label: "Созвон с командой, 12:15 – 13:00, 29 июля 2026 г." }] });
    const out = await src.poll();
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain("Созвон с командой");
    expect(out[0]!.title).toContain("через 15 мин");
    expect(out[0]!.key).toBe(`${at(12, 15)}|созвон с командой`);
  });

  it("встреча далеко за окном — молчим (не дёргаем за пять часов)", async () => {
    const { src } = sourceOf({ ok: true, events: [{ label: "Ужин, 20:00, 29 июля 2026 г." }] });
    expect(await src.poll()).toEqual([]);
  });

  it("прошедшая встреча не всплывает", async () => {
    const { src } = sourceOf({ ok: true, events: [{ label: "Планёрка, 09:00, 29 июля 2026 г." }] });
    expect(await src.poll()).toEqual([]);
  });

  it("событие «на весь день» не будит — у него нет времени начала", async () => {
    const { src } = sourceOf({ ok: true, events: [{ label: "Отпуск, 29 июля 2026 г." }], }, { now: () => new Date(2026, 6, 29, 0, 1, 0).getTime() });
    expect(await src.poll()).toEqual([]);
  });

  it("вкладка календаря не открыта → НЕ лезем и не сигналим (неинвазивность)", async () => {
    const { src, reader } = sourceOf({ ok: true, noTab: true, events: [] });
    expect(await src.poll()).toEqual([]);
    expect(reader.calendarRead).toHaveBeenCalledTimes(1);
  });

  it("расширение недоступно (throw) → пропуск без падения тика", async () => {
    const reader = { calendarRead: vi.fn(async () => { throw new Error("нет расширения"); }) };
    const src = createCalendarSource(reader, "u1", { now: () => NOW });
    expect(await src.poll()).toEqual([]);
  });

  it("ЧЕСТНОСТЬ: пустая (выгруженная) вкладка — деградация в метрики, а не «встреч нет»", async () => {
    const mod = await import("../../obs/metrics.js");
    const spy = vi.spyOn(mod.metrics, "recordDegradation").mockImplementation(() => {});
    const { src } = sourceOf({ ok: false, blank: true, error: "страница пуста" });
    expect(await src.poll()).toEqual([]);
    expect(spy).toHaveBeenCalledWith("calendar_unreadable", expect.objectContaining({ reason: "blank" }));
    spy.mockRestore();
  });

  it("ЧЕСТНОСТЬ: чипы есть, но разметка незнакома → деградация «не разобрал», а не тишина", async () => {
    const mod = await import("../../obs/metrics.js");
    const spy = vi.spyOn(mod.metrics, "recordDegradation").mockImplementation(() => {});
    const { src } = sourceOf({ ok: true, host: "calendar.example.com", events: [{ label: "какая-то плитка без времени" }] });
    expect(await src.poll()).toEqual([]);
    expect(spy).toHaveBeenCalledWith("calendar_chips_unparsed", expect.objectContaining({ chips: 1 }));
    spy.mockRestore();
  });

  it("пустой календарь (0 чипов) деградацией НЕ считается — это законное «встреч нет»", async () => {
    const mod = await import("../../obs/metrics.js");
    const spy = vi.spyOn(mod.metrics, "recordDegradation").mockImplementation(() => {});
    const { src } = sourceOf({ ok: true, events: [] });
    expect(await src.poll()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("деградации троттлятся — сломанная вкладка не заливает лог каждые полторы минуты", async () => {
    const mod = await import("../../obs/metrics.js");
    const spy = vi.spyOn(mod.metrics, "recordDegradation").mockImplementation(() => {});
    let clock = NOW;
    const reader = { calendarRead: vi.fn(async () => ({ ok: false, blank: true })) };
    const src = createCalendarSource(reader, "u1", { now: () => clock });
    await src.poll();
    clock += 90_000;
    await src.poll();
    expect(spy).toHaveBeenCalledTimes(1);
    clock += 31 * 60_000;
    await src.poll();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  // КОНТРОЛЬ-11 (MEDIUM): часть чипов разобралась, часть нет — раньше это молчало в метриках, и
  // «почему не предупредил о встрече» разбирать было не по чему.
  it("смешанный разбор (часть чипов не разобрана) → деградация пишется, сигналы по разобранному идут", async () => {
    const mod = await import("../../obs/metrics.js");
    const spy = vi.spyOn(mod.metrics, "recordDegradation").mockImplementation(() => {});
    const { src } = sourceOf({
      ok: true,
      host: "calendar.google.com",
      events: [{ label: "Созвон, 12:15 – 13:00, 29 июля 2026 г." }, { label: "Ретро с Ивановым" }],
    });
    const out = await src.poll();
    expect(out).toHaveLength(1); // о разобранном предупреждаем
    expect(spy).toHaveBeenCalledWith("calendar_chips_unparsed", expect.objectContaining({ parsed: 1 }));
    spy.mockRestore();
  });

  it("выключается флагом", async () => {
    const reader = { calendarRead: vi.fn(async () => ({ ok: true, events: [] })) };
    const src = createCalendarSource(reader, "u1", { enabled: () => false });
    expect(src.enabled()).toBe(false);
  });
});

describe("inMinutesPhrase / eventSignal", () => {
  it("человеческая формулировка «через сколько»", () => {
    expect(inMinutesPhrase(NOW + 15 * 60_000, NOW)).toBe("через 15 мин");
    expect(inMinutesPhrase(NOW + 30_000, NOW)).toBe("прямо сейчас");
    expect(inMinutesPhrase(NOW + 2 * 3600_000, NOW)).toBe("через 2 ч");
  });

  it("ключ сигнала стабилен для одного события — второй раз не объявим", () => {
    const ev = { title: "Созвон", startAt: at(15), allDay: false };
    expect(eventSignal(ev, "u1", NOW).key).toBe(eventSignal(ev, "u1", NOW + 60_000).key);
  });
});

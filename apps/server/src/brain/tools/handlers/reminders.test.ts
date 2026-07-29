/**
 * Хендлер set_reminder — ЧЕСТНОСТЬ подтверждения (контроль волны D).
 *
 * Два разобранных дефекта: (1) хендлер цитировал ВХОДЯЩИЙ текст и всегда говорил «поставлено», даже
 * когда сервис схлопнул просьбу в уже существующую запись — владелец услышал бы формулировку и ритм,
 * которых в сторе нет; (2) необязательное `repeat_seconds`, пришедшее от модели как null/""/0,
 * коэрсилось в «интервал 0 секунд» и роняло СОЗДАНИЕ обычного одноразового напоминания.
 */
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../dispatch.js";
import { setReminder } from "./reminders.js";

interface FakeAdd {
  sessionId: string;
  userId: string;
  text: string;
  fireAt: number;
  repeat?: unknown;
}

/** Сервис-заглушка: отдаёт то, что «лежит в сторе», а не то, что попросили. */
function ctxWith(reply: (a: FakeAdd) => Record<string, unknown>): { ctx: ToolContext; calls: FakeAdd[] } {
  const calls: FakeAdd[] = [];
  const ctx = {
    sessionId: "s1",
    userId: "u1",
    reminders: {
      add: (a: FakeAdd) => {
        calls.push(a);
        return { id: "r1", ...a, ...reply(a) };
      },
    },
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("setReminder — подтверждение отражает ЗАПИСЬ, а не просьбу", () => {
  it("схлопнуто в существующее (created:false) → честное «уже запланировано» + текст ИЗ СТОРА", async () => {
    const { ctx } = ctxWith((a) => ({ created: false, text: "Позвонить маме, сэр", fireAt: a.fireAt }));
    const res = await setReminder(ctx, { text: "Напоминаю: позвонить маме", delay_seconds: 3600 });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("уже запланировано");
    expect(res.content).toContain("Позвонить маме, сэр"); // прозвучит именно это
    expect(res.content).not.toContain("Напоминание поставлено");
  });

  it("создано → обычное подтверждение с ритмом из записи", async () => {
    const { ctx } = ctxWith((a) => ({ created: true, repeat: a.repeat }));
    const res = await setReminder(ctx, { text: "Пить таблетки", delay_seconds: 3600, repeat: "daily" });
    expect(res.content).toContain("Напоминание поставлено");
    expect(res.content).toContain("каждый день");
  });

  it("сервис вернул ОДНОРАЗОВОЕ вместо запрошенной серии → ритм не выдумываем", async () => {
    const { ctx } = ctxWith(() => ({ created: true, repeat: undefined }));
    const res = await setReminder(ctx, { text: "Пить таблетки", delay_seconds: 3600, repeat: "daily" });
    expect(res.content).not.toContain("каждый день");
  });
});

describe("setReminder — sentinel-значения необязательного repeat_seconds", () => {
  for (const rs of [null, "", 0] as const) {
    it(`repeat_seconds=${JSON.stringify(rs)} → одноразовое напоминание СОЗДАЁТСЯ (а не «интервал 0 сек»)`, async () => {
      const { ctx, calls } = ctxWith(() => ({ created: true }));
      const res = await setReminder(ctx, { text: "Позвонить маме", delay_seconds: 600, repeat_seconds: rs });
      expect(res.isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.repeat).toBeUndefined();
    });
  }

  it("настоящий интервал по-прежнему работает", async () => {
    const { ctx, calls } = ctxWith((a) => ({ created: true, repeat: a.repeat }));
    const res = await setReminder(ctx, { text: "Разминка", delay_seconds: 600, repeat_seconds: 3600 });
    expect(res.isError).toBeFalsy();
    expect(calls[0]!.repeat).toEqual({ kind: "interval", seconds: 3600 });
  });

  it("мусорный ритм — ЧЕСТНЫЙ отказ, а не тихое одноразовое", async () => {
    const { ctx, calls } = ctxWith(() => ({ created: true }));
    const res = await setReminder(ctx, { text: "Разминка", delay_seconds: 600, repeat: "каждое полнолуние" });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

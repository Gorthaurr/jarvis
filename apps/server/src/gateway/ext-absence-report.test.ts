/**
 * Тексты и порядок доклада об отсутствии расширения (ext-absence-report.ts).
 *
 * Реверт-проверки: «Chrome открыт» в настоящем времени → «прошедшее время»; дата/цифры в голосе → «голос без
 * дат»; лечение «Загрузить распакованное» при отказе пиннингом → «пиннинг»; голос раньше чата → «сбой голоса».
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExtAbsence, type ExtAbsenceDue } from "./ext-absence.js";
import { flushExtAbsence, formatExtAbsence } from "./ext-absence-report.js";

const SEEN = new Date(2026, 8, 24, 21, 15).getTime();
const due = (over: Partial<ExtAbsenceDue> = {}): ExtAbsenceDue => ({
  kind: "chrome",
  lastSeenAt: SEEN,
  absentMs: 3 * 3_600_000,
  chromeMs: 25 * 60_000,
  pinRejectedId: null,
  ...over,
});

describe("formatExtAbsence", () => {
  it("уверенный: Chrome — в прошедшем времени (его могли закрыть), шаги и путь — в чате", () => {
    const t = formatExtAbsence(due(), "C:\\jarvis\\apps\\extension");
    expect(t.voice).not.toMatch(/Chrome открыт/);
    expect(t.voice).toMatch(/работал/);
    expect(t.chat).toMatch(/около 25 мин/);
    expect(t.chat).toContain("24.09 в 21:15");
    expect(t.chat).toContain("«Загрузить распакованное» → папка C:\\jarvis\\apps\\extension");
  });

  it("голос без дат, цифр и путей (verbalize их не склоняет) — во всех видах доклада", () => {
    for (const d of [due(), due({ kind: "unknown" }), due({ pinRejectedId: "a".repeat(32) })]) {
      const v = formatExtAbsence(d, "C:\\x").voice;
      expect(v).not.toMatch(/\d|chrome:\/\/|\\/);
    }
  });

  it("мягкий: честно «если Chrome закрыт — подключится само», без утверждения, что он открыт", () => {
    const t = formatExtAbsence(due({ kind: "unknown", absentMs: 13 * 3_600_000 }), null);
    expect(t.chat).toMatch(/около 13 ч/);
    expect(t.chat).toMatch(/Если Chrome просто закрыт/);
    expect(t.chat).toContain("node apps/client/scripts/build.mjs"); // папка не найдена/не собрана — подсказать сборку
  });

  it("отказ пиннингом: лечение — ID (JARVIS_EXT_ID / key), а не «Загрузить распакованное»", () => {
    const t = formatExtAbsence(due({ pinRejectedId: "a".repeat(32) }), "C:\\x", "b".repeat(32));
    expect(t.chat).toContain("a".repeat(32));
    expect(t.chat).toContain("b".repeat(32));
    expect(t.chat).toContain("JARVIS_EXT_ID");
    expect(t.chat).not.toContain("Загрузить распакованное");
  });
});

describe("flushExtAbsence", () => {
  const ready = () => {
    const clock = { t: SEEN };
    const tracker = new ExtAbsence(() => join(mkdtempSync(join(tmpdir(), "ext-report-")), "ext-presence.json"), () => clock.t);
    tracker.tick("chrome", false);
    for (let i = 0; i < 3 * 240; i++) {
      clock.t += 15_000;
      tracker.tick("chrome", false);
    }
    return tracker;
  };

  it("сбой голоса не теряет доклад: чат уходит ПЕРВЫМ", () => {
    const tracker = ready();
    const order: string[] = [];
    const chat = vi.fn(() => void order.push("chat"));
    const speak = vi.fn(() => {
      order.push("speak");
      throw new Error("tts down");
    });
    expect(() => flushExtAbsence({ tracker, connected: false, ownerBusy: false, speak, chat, dir: null })).toThrow("tts down");
    expect(order).toEqual(["chat", "speak"]);
  });

  it("владелец занят → ни слова, флаг цел; освободился → доклад", () => {
    const tracker = ready();
    const chat = vi.fn();
    expect(flushExtAbsence({ tracker, connected: false, ownerBusy: true, speak: vi.fn(), chat, dir: null })).toBe(false);
    expect(chat).not.toHaveBeenCalled();
    expect(flushExtAbsence({ tracker, connected: false, ownerBusy: false, speak: vi.fn(), chat, dir: null })).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

/**
 * Тексты и порядок доклада об отсутствии расширения (ext-absence-report.ts).
 *
 * Реверт-проверки: «Chrome открыт» в настоящем времени → «прошедшее время»; дата/цифры в голосе → «голос без
 * дат»; лечение «Загрузить распакованное» при отказе пиннингом → «пиннинг»; голос раньше чата → «сбой голоса».
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExtAbsence, type ExtAbsenceDue } from "./ext-absence.js";
import { extensionDir, flushExtAbsence, formatExtAbsence } from "./ext-absence-report.js";
import { JARVIS_WEB_HANDS_EXT_ID as OURS } from "./ext-id.js";

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
    for (const d of [due(), due({ kind: "unknown" }), due({ pinRejectedId: OURS })]) {
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

  it("отказ пиннингом нашего ID: лечение — убрать устаревший JARVIS_EXT_ID, а не «Загрузить распакованное»", () => {
    const t = formatExtAbsence(due({ pinRejectedId: OURS }), "C:\\x", "b".repeat(32));
    expect(t.chat).toContain(OURS);
    expect(t.chat).toContain("b".repeat(32));
    expect(t.chat).toMatch(/Уберите JARVIS_EXT_ID/);
    expect(t.chat).not.toContain("Загрузить распакованное");
  });

  it("extensionDir: путь только к СОБРАННОМУ расширению (SW = dist/background.js), иначе null", () => {
    const d = mkdtempSync(join(tmpdir(), "ext-dir-"));
    writeFileSync(join(d, "manifest.json"), "{}");
    expect(extensionDir(d)).toBeNull();
    mkdirSync(join(d, "dist"));
    writeFileSync(join(d, "dist", "background.js"), "");
    expect(extensionDir(d)).toBe(d);
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

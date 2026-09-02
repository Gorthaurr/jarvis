/**
 * Разбор вывода Core Audio: чистые функции, без PowerShell.
 *
 * Реверт-проверка: порча сортировки (убрать `b.peak - a.peak`) роняет «звучащее идёт первым»,
 * порча `touched` роняет «ноль задетых — честная ошибка». Живой путь (COM, мьют chrome и возврат)
 * проверен прогоном на машине владельца 2026-09-01 — здесь закреплена логика поверх него.
 */
import { describe, expect, it } from "vitest";
import { parseApplied, parseSessions } from "./audio-sessions.js";

const LINE = (pid: number, proc: string, state: 0 | 1, muted: 0 | 1, vol: string, peak: string, title = "") =>
  [pid, proc, state, muted, vol, peak, title].join("\t");

describe("parseSessions", () => {
  it("разбирает строки Core Audio в сессии", () => {
    const out = parseSessions([LINE(24856, "chrome", 1, 0, "1", "0.4946"), LINE(1660, "electron", 1, 0, "0.5", "0")].join("\n"));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ pid: 24856, process: "chrome", state: "active", muted: false, volume: 1, peak: 0.4946 });
    expect(out[1]).toMatchObject({ pid: 1660, process: "electron", volume: 0.5, peak: 0 });
  });

  it("ЗВУЧАЩЕЕ идёт первым — это и есть ответ на «что это за звук»", () => {
    const out = parseSessions(
      [
        LINE(10220, "steam", 0, 0, "1", "0"),
        LINE(1660, "electron", 1, 0, "1", "0"),
        LINE(24856, "chrome", 1, 0, "1", "0.42"),
      ].join("\n"),
    );
    expect(out.map((s) => s.process)).toEqual(["chrome", "electron", "steam"]);
  });

  it("активное обходит неактивное при равном пике", () => {
    const out = parseSessions([LINE(1, "a", 0, 0, "1", "0"), LINE(2, "b", 1, 0, "1", "0")].join("\n"));
    expect(out[0]?.process).toBe("b");
  });

  it("мусорные и обрезанные строки пропускаются, а не роняют разбор", () => {
    const out = parseSessions(["", "не-строка", "1\t2", LINE(7, "ok", 1, 1, "0.3", "0.1")].join("\n"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ pid: 7, muted: true, volume: 0.3 });
  });

  it("заголовок сессии сохраняется (в нём бывает имя вкладки)", () => {
    const out = parseSessions(LINE(5, "chrome", 1, 0, "1", "0.2", "YouTube — видео"));
    expect(out[0]?.title).toBe("YouTube — видео");
  });
});

describe("parseApplied", () => {
  it("первая строка — счётчик задетых сессий, дальше их состояние ПОСЛЕ записи", () => {
    const r = parseApplied(["2", ["24856", "chrome", "1", "1"].join("\t"), ["24857", "chrome", "1", "1"].join("\t")].join("\n"));
    expect(r.touched).toBe(2);
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[0]).toMatchObject({ pid: 24856, process: "chrome", muted: true, volume: 1 });
  });

  it("ноль задетых читается как ноль — на этом строится честный отказ «глушить нечего»", () => {
    expect(parseApplied("0\n").touched).toBe(0);
  });

  it("снятие мьюта видно в обратном чтении", () => {
    const r = parseApplied(["1", ["24856", "chrome", "0", "0.5"].join("\t")].join("\n"));
    expect(r.sessions[0]).toMatchObject({ muted: false, volume: 0.5 });
  });
});

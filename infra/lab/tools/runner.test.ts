/**
 * Раннер кейсов: пропуск по неподдержанным видам команд, провал ожиданий, ошибка предусловия, таблица/JSON.
 * «ПК» — мини-заглушка (mini-desktop.ts), поэтому тест не зависит от наполненности FakeDesktop.
 */
import { describe, expect, it } from "vitest";
import type { ToolCase } from "./case-format.js";
import { miniDesktop, okResult } from "./mini-desktop.js";
import { formatTable, requiredKinds, runCase, runCases, skipReasonOf, summarize, toJson } from "./runner.js";

const all = new Set(["fs.read", "fs.write", "fs.delete", "window.list"]);
const mk = () => miniDesktop((_c, m) => okResult(m.commandId, "готово"));

const write: ToolCase = {
  tool: "fs_write",
  name: "пишет",
  args: { path: "C:/x.txt", content: "y" },
  expect: { ok: true, actionKinds: ["fs.write"] },
  coversTool: "fs_write",
};

describe("requiredKinds / skipReasonOf", () => {
  it("виды берутся из actionKinds и из инструментов before", () => {
    const c: ToolCase = { ...write, before: [{ tool: "fs_read", args: { path: "C:/x" } }], expect: { actionKinds: ["fs.write"] } };
    expect(requiredKinds(c).sort()).toEqual(["fs.read", "fs.write"]);
  });

  it("needsKinds: [] отключает вывод (кейс «гейт отказал до клиента»)", () => {
    expect(requiredKinds({ ...write, needsKinds: [] })).toEqual([]);
  });

  it("неподдержанный вид → причина названа; ручной skip приоритетнее", () => {
    expect(skipReasonOf(write, new Set())).toMatch(/fs\.write/);
    expect(skipReasonOf({ ...write, skip: "ждёт X" }, all)).toBe("ждёт X");
    expect(skipReasonOf(write, all)).toBeNull();
  });

  it("серверный кейс без видов запускается всегда", () => {
    const c: ToolCase = { tool: "list_reminders", name: "x", expect: { ok: true }, coversTool: "list_reminders" };
    expect(skipReasonOf(c, new Set())).toBeNull();
  });
});

describe("runCase", () => {
  it("совпавшие ожидания → pass, в отчёте видно, что произошло", async () => {
    const r = await runCase(write, { supported: all, makeDesktop: mk });
    expect(r.status).toBe("pass");
    expect(r.seen?.actionKinds).toEqual(["fs.write"]);
  });

  it("нарушенное ожидание → fail с человеческой причиной", async () => {
    const r = await runCase({ ...write, expect: { ok: true, actionKinds: ["fs.delete"] } }, { supported: all, makeDesktop: mk });
    expect(r.status).toBe("fail");
    expect(r.failures.join("\n")).toMatch(/ждали \[fs\.delete\], ушло \[fs\.write\]/);
  });

  it("неподдержанный вид → skip (НЕ pass), лаборатория даже не поднимается", async () => {
    const r = await runCase(write, { supported: new Set(), makeDesktop: () => { throw new Error("не должен создаваться"); } });
    expect(r.status).toBe("skip");
    expect(r.skipReason).toMatch(/fs\.write/);
  });

  it("предусловие упало → error (а не молчаливый pass основного вызова)", async () => {
    const c: ToolCase = { ...write, before: [{ tool: "look", args: { what: "bogus" } }] };
    const r = await runCase(c, { supported: all, makeDesktop: mk });
    expect(r.status).toBe("error");
    expect(r.failures[0]).toMatch(/предусловие look/);
  });

  it("кейс с before видит состояние, оставленное предусловием (сторы общие внутри кейса)", async () => {
    const c: ToolCase = {
      tool: "list_reminders",
      name: "видно",
      before: [{ tool: "set_reminder", args: { text: "Полить цветы", delay_seconds: 3600 } }],
      expect: { ok: true, resultIncludes: "Полить цветы" },
      coversTool: "list_reminders",
    };
    expect((await runCase(c, { supported: all, makeDesktop: mk })).status).toBe("pass");
  });

  it("кейсы не текут друг в друга: напоминание из первого не видно во втором", async () => {
    const setIt: ToolCase = { tool: "set_reminder", name: "ставит", args: { text: "Полить цветы", delay_seconds: 3600 }, expect: { ok: true }, coversTool: "set_reminder" };
    const list: ToolCase = { tool: "list_reminders", name: "пусто", expect: { ok: true, resultExcludes: "Полить цветы" }, coversTool: "list_reminders" };
    const rs = await runCases([setIt, list], { supported: all, makeDesktop: mk });
    expect(rs.map((r) => r.status)).toEqual(["pass", "pass"]);
  });
});

describe("отчёты", () => {
  it("таблица и JSON считают итоги по статусам", async () => {
    const rs = await runCases([write, { ...write, name: "падает", expect: { ok: false } }, { ...write, name: "пропуск", skip: "нет" }], { supported: all, makeDesktop: mk });
    expect(summarize(rs)).toEqual({ pass: 1, fail: 1, skip: 1, error: 0, total: 3 });
    const table = formatTable(rs);
    expect(table).toMatch(/PASS\s+fs_write: пишет/);
    expect(table).toMatch(/FAIL\s+fs_write: падает/);
    expect(table).toMatch(/skip\s+fs_write: пропуск.*нет/);
    expect(toJson(rs).summary.total).toBe(3);
  });
});

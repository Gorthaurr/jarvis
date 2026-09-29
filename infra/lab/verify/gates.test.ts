import { describe, expect, it } from "vitest";
import { GROWTH_LIMIT, compareRuns } from "./compare.js";
import { judgeFnLengths, loadFnBaseline } from "./fn-baseline.js";
import type { RunReport, StepResult } from "./types.js";

const row = (name: string, lines: number, file = "src/a.ts") => ({ file, name, lines });

describe("fn-lengths как храповик", () => {
  const base = { "src/a.ts::big": 300 };

  it("старый долг без роста — pass с пометкой о долге", () => {
    const o = judgeFnLengths([row("big", 300)], base);
    expect(o.status).toBe("pass");
    expect(o.notes?.[0]).toContain("известный долг: 1");
  });

  it("рост старой функции — fail", () => {
    const o = judgeFnLengths([row("big", 301)], base);
    expect(o.status).toBe("fail");
    expect(o.reason).toContain("300 → 301");
  });

  it("НОВАЯ функция длиннее порога — fail", () => {
    const o = judgeFnLengths([row("big", 300), row("fresh", 151, "src/b.ts")], base);
    expect(o.status).toBe("fail");
    expect(o.reason).toContain("src/b.ts::fresh");
  });

  it("усохшая/исчезнувшая — pass, но просит обновить baseline", () => {
    expect(judgeFnLengths([row("big", 200)], base).notes?.join(" ")).toContain("обнови fn-baseline.json");
    expect(judgeFnLengths([], base).notes?.join(" ")).toContain("убери из fn-baseline.json");
  });

  it("реальный baseline читается и не пуст", () => {
    expect(Object.keys(loadFnBaseline()).length).toBeGreaterThan(0);
  });
});

const step = (over: Partial<StepResult>): StepResult => ({ id: "s", title: "s", status: "pass", ms: 60_000, ...over });
const prevRun = (steps: StepResult[]): RunReport => ({
  version: 1, profile: "full", startedAt: "2026-09-28T00:00:00.000Z", finishedAt: "", ms: 0, base: null,
  host: { platform: "linux", node: "v22", chromePath: true }, ok: true, steps, audit: { skippedTests: 0, skippedSteps: [], unverified: [] },
});
const skippedT = (name: string) => ({ file: "a.test.ts", name, reason: "skipIf" });

describe("сравнение с прошлым прогоном", () => {
  it("нет прошлого прогона — pass, но честно «не сравнивали»", () => {
    const o = compareRuns(null, [step({})]);
    expect(o.status).toBe("pass");
    expect(o.unverified?.[0]).toContain("не выполнено");
  });

  it("новый пропущенный тест — fail; прежний пропуск — нет", () => {
    const prev = prevRun([step({ skipped: [skippedT("old")] })]);
    expect(compareRuns(prev, [step({ skipped: [skippedT("old")] })]).status).toBe("pass");
    const o = compareRuns(prev, [step({ skipped: [skippedT("old"), skippedT("new")] })]);
    expect(o.status).toBe("fail");
    expect(o.reason).toContain("новых пропущенных тестов: 1");
  });

  it("рост времени шага > 20% — fail, ровно на границе — нет", () => {
    const prev = prevRun([step({ ms: 100_000 })]);
    expect(compareRuns(prev, [step({ ms: 100_000 * GROWTH_LIMIT })]).status).toBe("pass");
    const o = compareRuns(prev, [step({ ms: 121_000 })]);
    expect(o.status).toBe("fail");
    expect(o.reason).toContain("+21%");
  });

  it("быстрые шаги (<10 с) — шум, не сравниваем", () => {
    expect(compareRuns(prevRun([step({ ms: 2_000 })]), [step({ ms: 9_000 })]).status).toBe("pass");
  });

  it("тестов стало меньше — замечание в notes (удаление тестов не должно быть тихим)", () => {
    const c = { total: 10, passed: 10, failed: 0, skipped: 0, todo: 0 };
    const o = compareRuns(prevRun([step({ tests: c })]), [step({ tests: { ...c, total: 7, passed: 7 } })]);
    expect(o.notes?.join(" ")).toContain("10 → 7");
  });
});

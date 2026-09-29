/**
 * evaluate(): КАЖДОЕ ожидание должно краснеть при нарушении и молчать при выполнении. Иначе кейсы «зелёные на всё»
 * (закон 1) — поэтому на каждое поле по паре «нарушено / выполнено» на синтетическом исходе.
 */
import { describe, expect, it } from "vitest";
import type { DesktopSnapshot } from "../lib/contracts.js";
import type { ToolExpect } from "./case-format.js";
import { evaluate, isSubset } from "./expect.js";
import type { ToolCallOutcome } from "./harness.js";

const snap: DesktopSnapshot = { windows: [], foregroundHwnd: null, clipboard: "abc", files: { "C:/a.txt": "x" }, volume: 30, muted: false, media: { playing: false }, locked: false, processes: {}, effects: [] };

function outcome(over: Partial<ToolCallOutcome> = {}): ToolCallOutcome {
  return {
    tool: "t",
    args: {},
    result: { content: "готово", isError: false },
    isError: false,
    text: "готово, файл сохранён",
    flags: {},
    asked: [],
    actions: [{ cmd: { kind: "fs.write", path: "C:/a.txt", content: "x" }, result: { commandId: "c", ok: true, durationMs: 1 }, ms: 1 }],
    effects: [{ n: 1, at: 0, kind: "fs.write", detail: { path: "C:/a.txt", bytes: 1 } }],
    snapshot: snap,
    ms: 1,
    ...over,
  };
}

/** [название, ожидание, исход, должно ли провалиться] */
const table: Array<[string, ToolExpect, Partial<ToolCallOutcome>, boolean]> = [
  ["ok:true при успехе", { ok: true }, {}, false],
  ["ok:true при ошибке", { ok: true }, { isError: true }, true],
  ["ok:false при успехе (ложный успех)", { ok: false }, {}, true],
  ["ok:false при ошибке", { ok: false }, { isError: true }, false],
  ["resultIncludes есть", { resultIncludes: "файл сохранён" }, {}, false],
  ["resultIncludes нет", { resultIncludes: "удалён" }, {}, true],
  ["resultIncludes regexp нет", { resultIncludes: [/удал[её]н/] }, {}, true],
  ["resultExcludes нарушено", { resultExcludes: "готово" }, {}, true],
  ["resultExcludes соблюдено", { resultExcludes: "ошибка" }, {}, false],
  ["флаг declined ждали true, нет", { flags: { declined: true } }, {}, true],
  ["флаг declined ждали true, есть", { flags: { declined: true } }, { result: { content: "x", isError: false, declined: true } }, false],
  ["флаг declined ждали false, есть", { flags: { declined: false } }, { result: { content: "x", isError: false, declined: true } }, true],
  ["actionKinds совпали", { actionKinds: ["fs.write"] }, {}, false],
  ["actionKinds лишняя команда", { actionKinds: [] }, {}, true],
  ["actionKinds другой порядок", { actionKinds: ["fs.write", "fs.read"] }, {}, true],
  ["asked совпало", { asked: 0 }, {}, false],
  ["asked не совпало", { asked: 1 }, {}, true],
  ["effects has + detail", { effects: [{ has: "fs.write", detail: { path: "C:/a.txt" } }] }, {}, false],
  ["effects has, другой detail", { effects: [{ has: "fs.write", detail: { path: "C:/b.txt" } }] }, {}, true],
  ["effects has, вида нет", { effects: [{ has: "fs.delete" }] }, {}, true],
  ["effects count 2, а был 1", { effects: [{ has: "fs.write", count: 2 }] }, {}, true],
  ["effects none нарушено", { effects: [{ none: "fs.write" }] }, {}, true],
  ["effects none соблюдено", { effects: [{ none: "fs.delete" }] }, {}, false],
  ["effects предикат false", { effects: [() => false] }, {}, true],
  ["effects предикат строка", { effects: [() => "плохо"] }, {}, true],
  ["state true", { state: (s) => s.volume === 30 }, {}, false],
  ["state строка-причина", { state: (s) => (s.volume === 31 ? true : `громкость ${s.volume}`) }, {}, true],
  ["notVerifiable ждали, вызван", { notVerifiable: /расширени/ }, {}, true],
  ["notVerifiable ждали, есть", { notVerifiable: /расширени/ }, { notVerifiable: "нужно расширение" }, false],
  ["notVerifiable не ждали, есть (кейс невозможен)", { ok: false }, { notVerifiable: "нужно расширение", isError: true }, true],
];

describe("evaluate: каждое ожидание краснеет на нарушении", () => {
  it.each(table)("%s", (_name, exp, over, mustFail) => {
    const fails = evaluate(exp, outcome(over));
    if (mustFail) expect(fails.length).toBeGreaterThan(0);
    else expect(fails).toEqual([]);
  });

  it("сообщение о провале называет ожидание и увиденное (идёт в отчёт)", () => {
    const [f] = evaluate({ actionKinds: [] }, outcome());
    expect(f).toContain("fs.write");
  });

  it("isSubset: вложенный объект, массивы строго по длине", () => {
    expect(isSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 })).toBe(true);
    expect(isSubset({ a: { b: 2 } }, { a: { b: 1 } })).toBe(false);
    expect(isSubset({ l: [1] }, { l: [1, 2] })).toBe(false);
  });
});

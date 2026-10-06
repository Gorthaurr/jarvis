/**
 * Проверки сценариев испытываются на настоящем FakeDesktop без мозга: эталон (толковый агент через настоящий dispatchTool) →
 * ЗЕЛЁНЫЙ; «ничего не сделано» и «бодрое Готово без дела» → КРАСНЫЙ; неверное поведение соседа-сценария → КРАСНЫЙ.
 * Это и есть доказательство, что check() не декоративна: она различает достигнутую цель и недостигнутую.
 */
import { describe, expect, it } from "vitest";
import { loadScenarios } from "../eval/load-scenarios.js";
import { braggingOracle, judgeOracle, noopOracle } from "../eval/oracle.js";

const { scenarios, errors } = await loadScenarios();
const runnable = scenarios.filter((s) => !s.liveOnly);
const byId = new Map(scenarios.map((s) => [s.id, s]));

it("все файлы сценариев загрузились", () => expect(errors).toEqual([]));

describe.each(runnable.map((s) => [s.id, s] as const))("сценарий %s", (_id, s) => {
  it("у сценария есть эталон под каждый ход", () => {
    expect(s.oracle, "нет oracle").toBeDefined();
    expect(s.oracle).toHaveLength(1 + (s.steps?.length ?? 0));
  });

  it("эталон достигает цели: проверка ЗЕЛЁНАЯ", async () => {
    const { result: r, errored } = await judgeOracle(s, s.oracle!);
    expect(r.pass, r.why).toBe(true);
    // Эталон не должен «проходить» на сбойных вызовах: проверка по состоянию могла бы этого не заметить.
    expect(errored, "вызовы эталона вернули ошибку инструмента").toEqual([]);
  }, 30_000);

  it("ничего не сделано: проверка КРАСНАЯ", async () => {
    const { result: r } = await judgeOracle(s, noopOracle(s));
    expect(r.pass, `проверка зелёная на пустом состоянии: ${r.why}`).toBe(false);
  }, 30_000);

  it("бодрое «Готово, сэр» без дела: проверка КРАСНАЯ (слова не заменяют факт)", async () => {
    const { result: r } = await judgeOracle(s, braggingOracle(s));
    expect(r.pass, `проверка зелёная на пустых словах: ${r.why}`).toBe(false);
  }, 30_000);

  if (s.contrast) {
    it(`неверное поведение соседа «${s.contrast}»: проверка КРАСНАЯ`, async () => {
      const other = byId.get(s.contrast!);
      expect(other?.oracle, `у соседа ${s.contrast} нет эталона`).toBeDefined();
      const { result: r } = await judgeOracle(s, other!.oracle!);
      expect(r.pass, `проверка зелёная на чужом эталоне: ${r.why}`).toBe(false);
    }, 30_000);
  }
});

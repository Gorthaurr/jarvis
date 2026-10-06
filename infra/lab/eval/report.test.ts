import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatTable } from "./report-table.js";
import { renderMarkdown } from "./report-md.js";
import { safeLabel, writeReport } from "./report-write.js";
import { runEval } from "./runner.js";
import { stubDeps } from "./stubs.js";
import { fail, pass, soundOff } from "./kit/index.js";
import type { EvalReportX, EvalScenario } from "./types.js";

const sc = (id: string, over: Partial<EvalScenario> = {}): EvalScenario => ({ id, title: `Заголовок ${id}`, goal: `цель ${id} | с чертой`, tags: [], covers: [], brain: "real", budget: { maxMs: 2_000 }, check: () => pass("ок"), ...over });
const scenarios = [
  sc("green"), sc("red", { check: () => fail("файла нет в ФС") }), sc("boom", { check: () => { throw new Error("баг"); } }),
  sc("deco", { check: () => pass("зелёная без мозга") }), sc("mute", { brain: "either", check: soundOff }), sc("live", { liveOnly: "нужен микрофон" }),
];

async function sample(): Promise<EvalReportX> {
  const { deps } = stubDeps(() => ({ answer: "Готово, сэр." }));
  return runEval(scenarios, { brain: "off", control: true, n: 2, label: "проба 1", deps });
}

describe("отчёт", () => {
  it("Markdown: сводка, провалы с причиной, ошибка прогона отдельно, контроль, пропуски", async () => {
    const md = renderMarkdown(await sample(), scenarios);
    expect(md).toContain("# Eval проба 1");
    expect(md).toMatch(/\| `green` \| Заголовок green \| 2\/2/u); // check зелёный без мозга — для контроля это сигнал тревоги
    expect(md).toContain("звук слышен"); // либо: провал сценария either (не контрольного) идёт в раздел провалов с причиной
    expect(md).toContain("ЗЕЛЁНАЯ без мозга — проверка ДЕКОРАТИВНА");
    expect(md).toContain("красная без мозга — проверка ловит провал");
    expect(md).toMatch(/\| `live` \| liveOnly: нужен микрофон \|/u);
    expect(md).not.toContain("| с чертой |"); // «|» внутри ячейки экранирован
  });

  it("real: провал проверки — с причиной, ошибка прогона — отдельным видом, бюджет не смешивается с ошибкой", async () => {
    const { deps } = stubDeps(() => ({ answer: "Готово, сэр." }));
    const md = renderMarkdown(await runEval(scenarios, { brain: "real", deps }), scenarios);
    expect(md).toMatch(/### `red` #1 — провал проверки\n[\s\S]*?причина: файла нет в ФС/u);
    expect(md).toMatch(/### `boom` #1 — ОШИБКА ПРОГОНА \(не провал проверки\)/u);
    expect(md).toContain("check() сценария «boom» упал: баг");
    expect(md).not.toContain("Отрицательный контроль");
  });

  it("сводка считает pass/fail/error и pass-rate", async () => {
    const rep = await sample();
    expect(rep.bySrenario.red).toMatchObject({ pass: 0, fail: 2, total: 2, rate: 0 });
    expect(rep.bySrenario.boom).toMatchObject({ error: 2, pass: 0 });
    expect(rep.bySrenario.green).toMatchObject({ pass: 2, total: 2, rate: 1 });
    expect(renderMarkdown(rep, scenarios)).toMatch(/\| `mute` \|[^|]*\| 0\/2 \|/u);
  });

  it("таблица терминала: строка на прогон + пропуски + итог", async () => {
    const t = formatTable(await sample());
    expect(t).toMatch(/FAIL\s+red\s+#1/u);
    expect(t).toMatch(/ERR\s+boom/u);
    expect(t).toContain("[контроль]");
    expect(t).toMatch(/skip\s+live\s+liveOnly: нужен микрофон/u);
    expect(t).toMatch(/режим off \| прогонов 10:/u);
  });

  describe("запись на диск", () => {
    let dir = "";
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
    it("eval-<метка>.md и .json; метка очищена от опасных символов", async () => {
      dir = mkdtempSync(join(tmpdir(), "eval-rep-"));
      const rep = await sample();
      const { md, json } = writeReport(rep, scenarios, dir);
      expect(md).toBe(`${dir}/eval-проба-1.md`);
      expect(existsSync(json)).toBe(true);
      expect(JSON.parse(readFileSync(json, "utf8"))).toMatchObject({ label: "проба 1", mode: "off", runs: expect.any(Array), bySrenario: expect.any(Object) });
      expect(readFileSync(md, "utf8")).toContain("# Eval проба 1");
      expect(safeLabel("../../x y:z")).toBe("x-y-z");
      expect(safeLabel("///")).toBe("run");
    });
  });
});

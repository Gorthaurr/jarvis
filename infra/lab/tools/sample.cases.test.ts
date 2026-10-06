/**
 * Образцовые кейсы на НАСТОЯЩЕМ FakeDesktop. Серверные идут сразу; зависящие от «ПК» помечаются skip с причиной, пока
 * соседний строитель не научил FakeDesktop нужному виду команд, — и оживают сами.
 */
import { describe, expect, it } from "vitest";
import { TOOLS_BY_NAME } from "../../../packages/tools/src/index.js";
import { supportedKinds } from "../desktop/index.js";
import { caseId } from "./case-format.js";
import { cases } from "./cases/sample.cases.js";
import { loadCases } from "./load-cases.js";
import { skipReasonOf } from "./runner.js";
import { describeCases } from "./vitest-adapter.js";

describeCases("образцовые кейсы инструментов", cases);

describe("образцы: целостность", () => {
  it("id кейсов уникальны, coversTool — настоящий инструмент из схем", () => {
    const ids = cases.map(caseId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cases) expect(TOOLS_BY_NAME[c.coversTool], `${caseId(c)}: coversTool=${c.coversTool}`).toBeDefined();
  });

  it("загрузчик находит sample.cases.ts и не теряет кейсы", async () => {
    const l = await loadCases();
    expect(l.files.filter((f) => f.error)).toEqual([]);
    expect(l.cases.length).toBeGreaterThanOrEqual(cases.length);
  });

  it("минимум 9 образцов живут БЕЗ FakeDesktop (серверные гейты/сервисы) — эталон не превращается в сплошной skip", () => {
    const alive = cases.filter((c) => skipReasonOf(c, new Set()) === null);
    expect(alive.length).toBeGreaterThanOrEqual(9);
  });

  it("FakeDesktop-образцы пропускаются ТОЛЬКО из-за неподдержанного вида (не тихо)", () => {
    const have = new Set(supportedKinds());
    for (const c of cases) {
      const why = skipReasonOf(c, have);
      if (why) expect(why, caseId(c)).toMatch(/FakeDesktop ещё не умеет/);
    }
  });
});

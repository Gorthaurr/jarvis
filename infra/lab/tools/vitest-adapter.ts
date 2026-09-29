/**
 * Интеграция с vitest: `describeCases("имя", cases)` — по `it` на кейс. Пропущенные (FakeDesktop не умеет вид команд)
 * идут как `it.skip` с причиной в названии — в отчёте vitest видно, что не проверено, а не «зелёное».
 */
import { describe, expect, it } from "vitest";
import { supportedKinds } from "../desktop/index.js";
import { type ToolCase, caseId } from "./case-format.js";
import { runCase, skipReasonOf } from "./runner.js";

export function describeCases(title: string, cases: readonly ToolCase[]): void {
  const supported = new Set(supportedKinds());
  describe(title, () => {
    for (const c of cases) {
      const skip = skipReasonOf(c, supported);
      if (skip) {
        it.skip(`${caseId(c)} [${skip}]`, () => {});
        continue;
      }
      it(caseId(c), async () => {
        const r = await runCase(c, { supported });
        expect(r.status === "pass" ? [] : r.failures, r.failures.join("\n")).toEqual([]);
        expect(r.status).toBe("pass");
      });
    }
  });
}

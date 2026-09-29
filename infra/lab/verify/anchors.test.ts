import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { anchorsOutcome, mutationReportOutcome, validateAnchors } from "./anchors.js";

const dir = mkdtempSync(join(tmpdir(), "lab-anchors-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "src"), { recursive: true });
writeFileSync(join(dir, "src", "a.ts"), "function f() {\n    const x = 1;\n    if (ok) {\n      run();\n    }\n    twice();\n    twice();\n}\n");

/** Макет как в apps/server/scripts/mutate-loop.cjs: FILES, MUTS, findAnchor и маркер const names. */
const script = (muts: string): string => `
const fs = require("fs");
const FILES = ["src/a.ts"];
const MUTS = { ${muts} };
function findAnchor(lines, anchor) {
  const parts = anchor.split("\\n").map((s) => s.trim());
  const hits = [];
  for (let i = 0; i + parts.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < parts.length; k++) if (!lines[i + k].trim().includes(parts[k])) { ok = false; break; }
    if (ok) hits.push(i);
  }
  return hits;
}
const names = [];
throw new Error("валидатор не должен выполнять остальной скрипт");
`;
const run = (muts: string) => {
  const p = join(dir, "mutate-loop.cjs");
  writeFileSync(p, script(muts));
  return validateAnchors(p, dir);
};

describe("validateAnchors: якорь мутации найден ровно один раз", () => {
  it("однострочный и многострочный якоря на месте — problem=null (остальной скрипт не выполняется)", () => {
    const rows = run('"one": ["const x = 1;", "const x = 2;"], "multi": ["if (ok) {\\nrun();", "if (no) {\\nrun();"]');
    expect(rows).toEqual([{ name: "one", problem: null }, { name: "multi", problem: null }]);
  });

  it("якорь пропал → «anchor not found»", () => {
    const rows = run('"gone": ["const y = 1;", "const y = 2;"]');
    expect(rows).toEqual([{ name: "gone", problem: "anchor not found" }]);
  });

  it("якорь встречается дважды → «anchor not unique»", () => {
    const rows = run('"dup": ["twice();", "once();"]');
    expect(rows[0]?.problem).toContain("anchor not unique in src/a.ts");
  });

  it("макет скрипта изменился → исключение с объяснением, не «всё хорошо»", () => {
    const p = join(dir, "other.cjs");
    writeFileSync(p, "const MUTS = {};");
    expect(() => validateAnchors(p, dir)).toThrow(/макет mutate-loop\.cjs изменился/u);
  });

  it("cwd процесса восстанавливается", () => {
    const before = process.cwd();
    run('"one": ["const x = 1;", "z"]');
    expect(process.cwd()).toBe(before);
  });
});

describe("anchorsOutcome / mutationReportOutcome", () => {
  it("любая проблема якоря = fail с именами; пустая таблица = fail", () => {
    const bad = anchorsOutcome([{ name: "a", problem: null }, { name: "b", problem: "anchor not found" }]);
    expect(bad.status).toBe("fail");
    expect(bad.reason).toContain("b — anchor not found");
    expect(anchorsOutcome([]).status).toBe("fail");
    expect(anchorsOutcome([{ name: "a", problem: null }]).status).toBe("pass");
  });

  it("отчёт mutate-loop: строка с error падает; выживший мутант — не fail, но unverified", () => {
    const err = mutationReportOutcome(JSON.stringify([{ name: "m1", error: "anchor not found" }, { name: "m2", file: "x.ts", failed: ["t"] }]));
    expect(err.status).toBe("fail");
    expect(err.reason).toContain("m1: anchor not found");
    const surv = mutationReportOutcome(JSON.stringify([{ name: "m2", file: "x.ts", failed: ["t"] }, { name: "m3", file: "y.ts", failed: [] }]));
    expect(surv.status).toBe("pass");
    expect(surv.unverified).toEqual(["мутант «m3» выжил: ни один тест не упал"]);
  });

  it("vitest внутри mutate-loop не отдал JSON → fail; битый отчёт → fail", () => {
    expect(mutationReportOutcome(JSON.stringify([{ name: "m", file: "x.ts", failed: ["<json parse failed> ..."] }])).status).toBe("fail");
    expect(mutationReportOutcome("{oops").status).toBe("fail");
  });
});

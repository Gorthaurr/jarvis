import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { explainSkipped, findOnlySites, findSkipSites } from "./skip-audit.js";
import { vitestOutcome } from "./tools.js";
import type { Ctx, ExecResult } from "./types.js";

const dir = mkdtempSync(join(tmpdir(), "lab-tools-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ctx = { root: "C:/repo", workDir: dir } as Ctx;
const res = (over: Partial<ExecResult> = {}): ExecResult => ({ code: 0, signal: null, timedOut: false, ms: 1, out: "", truncated: false, ...over });
const write = (name: string, data: unknown): string => {
  const p = join(dir, name);
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
  return p;
};
const file = (status: string, ...as: string[]) => ({ name: "C:\\repo\\a.test.ts", status, assertionResults: as.map((s, i) => ({ status: s, fullName: `t${i}` })) });

describe("vitestOutcome: что считается зелёным", () => {
  it("все тесты прошли и код 0 → pass со счётчиками", () => {
    const o = vitestOutcome(res(), ctx, write("ok.json", { testResults: [file("passed", "passed", "passed")] }));
    expect(o.status).toBe("pass");
    expect(o.tests).toMatchObject({ total: 2, passed: 2 });
  });

  it("код 0, но нет отчёта → fail (не «всё хорошо»)", () => {
    expect(vitestOutcome(res(), ctx, join(dir, "нет-такого.json")).status).toBe("fail");
  });

  it("пустой набор: без allowZero — fail; с allowZero — pass, но в unverified", () => {
    const p = write("zero.json", { testResults: [] });
    const strict = vitestOutcome(res(), ctx, p);
    expect(strict.status).toBe("fail");
    expect(strict.reason).toContain("0 тестов");
    const lenient = vitestOutcome(res(), ctx, p, { allowZero: true, zeroNote: "нечего проверять" });
    expect(lenient.status).toBe("pass");
    expect(lenient.unverified).toEqual(["нечего проверять"]);
  });

  it("--passWithNoTests без отчёта, но с фразой vitest → честный 0 тестов; без фразы — авария", () => {
    const missing = join(dir, "absent.json");
    expect(vitestOutcome(res({ out: "No test files found, exiting with code 0" }), ctx, missing, { allowZero: true }).tests?.total).toBe(0);
    expect(vitestOutcome(res({ out: "какой-то вывод" }), ctx, missing, { allowZero: true }).status).toBe("fail");
  });

  it("упавший тест при коде 0 или упавший файл целиком → fail", () => {
    expect(vitestOutcome(res(), ctx, write("f1.json", { testResults: [file("failed", "passed", "failed")] })).status).toBe("fail");
    expect(vitestOutcome(res(), ctx, write("f2.json", { testResults: [file("failed")] })).status).toBe("fail");
  });

  it("ненулевой код при чистом отчёте → fail; таймаут → fail", () => {
    const p = write("ok2.json", { testResults: [file("passed", "passed")] });
    expect(vitestOutcome(res({ code: 1 }), ctx, p).status).toBe("fail");
    expect(vitestOutcome(res({ timedOut: true, code: null }), ctx, p).status).toBe("fail");
  });

  it("пропущенные тесты: pass, но с unverified и списком skipped", () => {
    const o = vitestOutcome(res(), ctx, write("sk.json", { testResults: [file("passed", "passed", "skipped", "todo")] }));
    expect(o.status).toBe("pass");
    expect(o.skipped).toHaveLength(1);
    expect(o.unverified?.join(" ")).toContain("1 тестов пропущено");
    expect(o.unverified?.join(" ")).toContain("todo");
  });
});

describe("аудит пропусков: причина из исходника", () => {
  it("находит skipIf/skip/todo и .only в тест-файлах, игнорирует не-тесты и node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "lab-skip-"));
    try {
      mkdirSync(join(root, "pkg", "node_modules"), { recursive: true });
      writeFileSync(join(root, "pkg", "a.test.ts"), 'it.skipIf(!chrome)("x", () => {});\ndescribe.skip("y", () => {});\nit("z", () => {});\n');
      writeFileSync(join(root, "pkg", "b.test.ts"), ["it.", "only(\"q\", () => {});"].join(""));
      writeFileSync(join(root, "pkg", "helper.ts"), 'it.skip("не тест-файл", () => {});');
      writeFileSync(join(root, "pkg", "node_modules", "c.test.ts"), 'it.skip("чужое", () => {});');
      const skips = findSkipSites(root, ["pkg"]);
      expect(skips.map((s) => `${s.file}:${s.line}`)).toEqual(["pkg/a.test.ts:1", "pkg/a.test.ts:2"]);
      expect(findOnlySites(root, ["pkg"]).map((s) => s.file)).toEqual(["pkg/b.test.ts"]);
      const [t] = explainSkipped([{ file: "pkg/a.test.ts", name: "x" }], skips);
      expect(t?.reason).toContain("skipIf(!chrome)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("причину не нашли — так и пишем, не выдумываем", () => {
    const [t] = explainSkipped([{ file: "nope.test.ts", name: "x" }], []);
    expect(t?.reason).toContain("причина не найдена");
  });
});

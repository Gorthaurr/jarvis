import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildReport, formatSummary, reportFileName, writeReport } from "./report.js";
import { runSteps } from "./runner.js";
import type { Ctx, Step } from "./types.js";

const dir = mkdtempSync(join(tmpdir(), "lab-runner-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ctx: Ctx = { root: process.cwd(), profile: "quick", base: "origin/main", env: {}, platform: process.platform, workDir: dir, runsDir: dir };
const node = process.execPath;
const sh = (id: string, code: string, extra: Partial<Step> = {}): Step => ({
  id, title: id, profiles: ["quick"], timeoutMs: 10_000, exec: () => ({ cmd: node, args: ["-e", code], cwd: process.cwd() }), ...extra,
});
const report = (steps: Awaited<ReturnType<typeof runSteps>>) =>
  buildReport({ profile: "quick", startedAt: new Date(2026, 8, 29, 1, 2, 3), finishedAt: new Date(2026, 8, 29, 1, 2, 9), base: "origin/main", chromePath: false, steps });

describe("runSteps: статусы", () => {
  it("код 0 = pass, ненулевой = fail с кодом, таймаут = fail и процесс убит", async () => {
    const res = await runSteps([sh("ok", "process.exit(0)"), sh("bad", "process.exit(7)"), sh("hang", "setTimeout(()=>{},20000)", { timeoutMs: 400 })], ctx);
    expect(res.map((r) => r.status)).toEqual(["pass", "fail", "fail"]);
    expect(res[1]?.reason).toContain("7");
    expect(res[2]?.timedOut).toBe(true);
    expect(res[2]?.reason).toContain("таймаут");
  });

  it("gate пропускает шаг С ПРИЧИНОЙ и не запускает процесс; gate fail — это fail", async () => {
    let started = false;
    const gated = sh("g", "process.exit(0)", { gate: () => ({ status: "skip", reason: "нет Xvfb" }), exec: () => { started = true; return { cmd: node, args: ["-e", ""], cwd: process.cwd() }; } });
    const failing = sh("f", "process.exit(0)", { gate: () => ({ status: "fail", reason: "CHROME_PATH не задан" }) });
    const res = await runSteps([gated, failing], ctx);
    expect(started).toBe(false);
    expect(res.map((r) => [r.status, r.reason])).toEqual([["skip", "нет Xvfb"], ["fail", "CHROME_PATH не задан"]]);
  });

  it("исключение в parse/inproc = fail с причиной, а не падение раннера", async () => {
    const res = await runSteps([
      sh("p", "process.exit(0)", { parse: () => { throw new Error("сломанный разбор"); } }),
      { id: "i", title: "i", profiles: ["quick"], timeoutMs: 5000, inproc: async () => { throw new Error("сломанный inproc"); } },
    ], ctx);
    expect(res.map((r) => r.status)).toEqual(["fail", "fail"]);
    expect(res[0]?.reason).toContain("сломанный разбор");
    expect(res[1]?.reason).toContain("сломанный inproc");
  });

  it("inproc, который не завершается, обрывается по таймауту шага", async () => {
    const hang: Step = { id: "h", title: "h", profiles: ["quick"], timeoutMs: 300, inproc: () => new Promise(() => {}) };
    const [r] = await runSteps([hang], ctx);
    expect(r?.status).toBe("fail");
    expect(r?.reason).toContain("таймаут");
  });

  it("inproc получает результаты предыдущих шагов", async () => {
    let seen: string[] = [];
    const spy: Step = { id: "s", title: "s", profiles: ["quick"], timeoutMs: 5000, inproc: async (_c, done) => { seen = done.map((d) => d.id); return { status: "pass" }; } };
    await runSteps([sh("first", "process.exit(0)"), spy], ctx);
    expect(seen).toEqual(["first"]);
  });

  it("шаги одной group идут параллельно, а следующий за группой — после неё", async () => {
    const slow = (id: string): Step => sh(id, "setTimeout(()=>{},600)", { group: "g" });
    const t0 = Date.now();
    const res = await runSteps([slow("a"), slow("b"), slow("c"), sh("after", "process.exit(0)")], ctx);
    expect(Date.now() - t0).toBeLessThan(1700); // последовательно было бы ≥ 1800 мс на группу
    expect(res.map((r) => r.id)).toEqual(["a", "b", "c", "after"]);
  });

  it("outputTail только у упавших шагов", async () => {
    const res = await runSteps([sh("ok", 'console.log("fine")'), sh("bad", 'console.log("boom-marker"); process.exit(1)')], ctx);
    expect(res[0]?.outputTail).toBeUndefined();
    expect(res[1]?.outputTail).toContain("boom-marker");
  });
});

describe("отчёт и код выхода", () => {
  it("ok=false при любом fail; skip с причиной не валит, но попадает в аудит", async () => {
    const red = report(await runSteps([sh("ok", "process.exit(0)"), sh("bad", "process.exit(1)")], ctx));
    expect(red.ok).toBe(false);
    const skipped = await runSteps([sh("ok", "process.exit(0)"), sh("bench", "process.exit(0)", { gate: () => ({ status: "skip", reason: "win32" }) })], ctx);
    const green = report(skipped);
    expect(green.ok).toBe(true);
    expect(green.audit.skippedSteps).toEqual([{ id: "bench", reason: "win32" }]);
    expect(green.audit.unverified.join("\n")).toContain("bench: ПРОПУЩЕН — win32");
  });

  it("пустой набор шагов не бывает зелёным", () => {
    expect(report([]).ok).toBe(false);
  });

  it("аудит собирает пропущенные тесты и unverified шагов", () => {
    const r = report([{ id: "v", title: "v", status: "pass", ms: 1, skipped: [{ file: "a.test.ts", name: "t", reason: "skipIf(!chrome)" }], unverified: ["1 тест пропущен"] }]);
    expect(r.audit.skippedTests).toBe(1);
    expect(r.audit.unverified).toEqual(["v: 1 тест пропущен"]);
    expect(formatSummary(r)).toContain("skipIf(!chrome)");
    expect(formatSummary(r)).toContain("ЗЕЛЁНОЕ");
  });

  it("JSON пишется в каталог под именем даты-времени и читается обратно", () => {
    const r = report([{ id: "x", title: "x", status: "pass", ms: 5 }]);
    expect(reportFileName(new Date(2026, 8, 29, 1, 2, 3))).toBe("20260929-010203.json");
    const file = writeReport(r, join(dir, "nested", "runs"));
    expect(file.endsWith("20260929-010203.json")).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, profile: "quick", ok: true });
  });
});

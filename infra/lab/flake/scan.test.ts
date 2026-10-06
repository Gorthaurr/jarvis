import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "../verify/types.js";
import { flakeOutcome } from "../verify/steps-flake.js";
import { targetsForFiles } from "../verify/changed.js";
import { knownFlakeOf } from "./known.js";
import { classify, describeFlakes, scanFlakes, type Outcome, type RunOutcomes } from "./scan.js";
import { vitestRunOnce } from "./vitest-run.js";

const run = (o: Record<string, Outcome>): RunOutcomes => new Map(Object.entries(o));

describe("classify: стабильно / нестабильно (n из K)", () => {
  it("2 падения из 5 — нестабильно; всегда зелёный — стабильно; пропуски не считаются", () => {
    const runs = [
      run({ flaky: "failed", steady: "passed", skipper: "skipped" }),
      run({ flaky: "passed", steady: "passed", skipper: "skipped" }),
      run({ flaky: "passed", steady: "passed", skipper: "skipped" }),
      run({ flaky: "failed", steady: "passed", skipper: "skipped" }),
      run({ flaky: "passed", steady: "passed", skipper: "skipped" }),
    ];
    const r = classify("pkg", runs, []);
    expect(r.runs).toBe(5);
    expect(r.unstable).toEqual([{ test: "flaky", failed: 2, of: 5 }]);
    expect(r.stable).toBe(2);
    expect(describeFlakes(r)).toContain("НЕСТАБИЛЬНО 2 из 5: flaky");
  });

  it("падает во всех прогонах — это сломанный тест, не флейк", () => {
    const r = classify("pkg", [run({ t: "failed" }), run({ t: "failed" }), run({ t: "failed" })], []);
    expect(r.alwaysFailed).toEqual([{ test: "t", failed: 3, of: 3 }]);
    expect(r.unstable).toEqual([]);
  });

  it("пропуск в одном из прогонов не размывает вердикт: падал везде, где запускался — сломан, а не мигает", () => {
    const r = classify("pkg", [run({ t: "failed" }), run({ t: "skipped" }), run({ t: "failed" })], []);
    expect(r.alwaysFailed).toEqual([{ test: "t", failed: 2, of: 2 }]);
    expect(r.unstable).toEqual([]);
  });

  it("известный флейк уходит в knownUnstable с причиной и не считается новой проблемой", () => {
    const known = [{ match: "pin.chromium.test.ts", reason: "живая сеть" }];
    const r = classify("client", [run({ "a/pin.chromium.test.ts > dns": "failed" }), run({ "a/pin.chromium.test.ts > dns": "passed" })], known);
    expect(r.unstable).toEqual([]);
    expect(r.knownUnstable[0]).toMatchObject({ failed: 1, of: 2, known: "живая сеть" });
    expect(flakeOutcome([r]).status).toBe("pass");
    expect(flakeOutcome([r]).notes?.join(" ")).toContain("известный флейк");
  });

  it("реестр известных флейков сматчен на файл pin.chromium", () => {
    expect(knownFlakeOf("apps/client/main/jarvis-browser-pin.chromium.test.ts > x")?.reason).toContain("example.com");
    expect(knownFlakeOf("apps/server/src/whatever.test.ts > x")).toBeUndefined();
  });

  it("пустые прогоны (vitest не дожил до отчёта) считаются и валят шаг", () => {
    const r = classify("pkg", [run({ t: "passed" }), run({})], []);
    expect(r.emptyRuns).toBe(1);
    const o = flakeOutcome([r]);
    expect(o.status).toBe("fail");
    expect(o.reason).toContain("не дали отчёта");
  });

  it("flakeOutcome: неизвестный нестабильный и упавший всегда валят прогон", () => {
    expect(flakeOutcome([classify("p", [run({ t: "failed" }), run({ t: "passed" })], [])]).status).toBe("fail");
    expect(flakeOutcome([classify("p", [run({ t: "failed" }), run({ t: "failed" })], [])]).status).toBe("fail");
    expect(flakeOutcome([classify("p", [run({ t: "passed" }), run({ t: "passed" })], [])]).status).toBe("pass");
  });
});

describe("targetsForFiles: раскладка изменённых тестов по vitest-проектам", () => {
  it("пакет → cwd пакета и путь от него; лаборатория → --root infra/lab; прочее — вне скана", () => {
    const { targets, unscanned } = targetsForFiles("/r", ["apps/server/src/a.test.ts", "apps/server/src/b.test.ts", "infra/lab/verify/x.test.ts", "apps/extension/test/p.test.mjs"]);
    expect(targets).toEqual([
      { id: "apps/server", cwd: "/r/apps/server", args: ["src/a.test.ts", "src/b.test.ts"] },
      { id: "infra/lab", cwd: "/r", args: ["--root", "infra/lab", "verify/x.test.ts"] },
    ]);
    expect(unscanned).toEqual(["apps/extension/test/p.test.mjs"]);
  });
});

describe("scanFlakes с настоящим vitest (мини-проект flake/fixtures)", () => {
  const work = mkdtempSync(join(tmpdir(), "lab-flake-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

  it("4 прогона: flip нестабилен 2 из 4, broken падает всегда, steady стабилен, skip не мешает", async () => {
    process.env.FLAKE_COUNTER_FILE = join(work, "counter.txt");
    try {
      const root = fileURLToPath(new URL("../../../", import.meta.url)).split("\\").join("/").replace(/\/$/u, "");
      const ctx = { root, workDir: work } as Ctx;
      const once = vitestRunOnce(ctx, { id: "fixture", cwd: fixtures.replace(/\/$/u, ""), args: [] }, 60_000);
      const r = await scanFlakes("fixture", 4, once, []);
      expect(r.emptyRuns).toBe(0);
      expect(r.unstable.map((u) => `${u.test.split(" > ")[1]}:${u.failed}/${u.of}`)).toEqual(["flip:2/4"]);
      expect(r.alwaysFailed.map((u) => u.test.split(" > ")[1])).toEqual(["broken"]);
      expect(r.stable).toBe(2); // steady + skipped-always (пропуск не нестабильность)
    } finally {
      delete process.env.FLAKE_COUNTER_FILE;
    }
  }, 120_000);
});

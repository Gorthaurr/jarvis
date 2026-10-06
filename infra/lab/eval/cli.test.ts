import { describe, expect, it } from "vitest";
import { type EvalArgs, parseEvalArgs, spendRefusal } from "./cli-args.js";
import { type CliIo, exitCodeOf, runCli } from "./cli-run.js";
import { runEval } from "./runner.js";
import { stubDeps } from "./stubs.js";
import { fail, pass } from "./kit/index.js";
import type { EvalOptions, EvalReportX, EvalScenario } from "./types.js";

const sc = (id: string, over: Partial<EvalScenario> = {}): EvalScenario => ({ id, title: id, goal: "цель", tags: ["t"], covers: [], brain: "either", budget: { maxMs: 1_000 }, check: () => pass("ок"), ...over });

function harness(scenarios: EvalScenario[], loadErrors: string[] = []) {
  const calls = { load: 0, run: [] as EvalOptions[], write: 0 };
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    load: async () => {
      calls.load += 1;
      return { scenarios, errors: loadErrors };
    },
    run: (all, o) => {
      calls.run.push(o);
      return runEval(all, { ...o, deps: stubDeps(() => ({ answer: "Готово." })).deps });
    },
    write: (rep) => {
      calls.write += 1;
      return { md: `/x/eval-${rep.label}.md`, json: "/x/y.json" };
    },
  };
  return { io, calls, out, err };
}

const args = (argv: string[]): EvalArgs => {
  const r = parseEvalArgs(argv);
  if (!r.ok) throw new Error(r.error);
  return r.args;
};

describe("разбор аргументов", () => {
  it("умолчания: off, n=1, запись отчёта включена, без --yes-spend", () => {
    expect(parseEvalArgs([])).toEqual({ ok: true, args: { brain: "off", yesSpend: false, n: 1, list: false, control: false, json: false, write: true } });
  });
  it("все флаги", () => {
    const r = parseEvalArgs(["--brain", "real", "--yes-spend", "--n", "3", "--filter", "файл", "--tag", "safety", "--label", "м1", "--json", "--no-write"]);
    expect(r).toMatchObject({ ok: true, args: { brain: "real", yesSpend: true, n: 3, filter: "файл", tag: "safety", label: "м1", json: true, write: false } });
  });
  it.each([
    [["--brain", "scripted"], /допустимо off\|real.*шва/u],
    [["--brain", "gpt"], /допустимо/u],
    [["--n", "0"], /1\.\.50/u],
    [["--n", "abc"], /1\.\.50/u],
    [["--n", "99"], /1\.\.50/u],
    [["--bogus"], /неизвестный флаг/u],
    [["лишнее"], /лишний аргумент/u],
    [["--filter"], /нужно значение/u],
    [["--control", "--brain", "real"], /только с --brain off/u],
  ])("отказ на %j", (argv, re) => {
    const r = parseEvalArgs(argv);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(re);
  });
  it("spendRefusal: real без --yes-spend отказывает и объясняет про подписку; off, --list и real с согласием — нет", () => {
    expect(spendRefusal(args(["--brain", "real"]))).toMatch(/подписк.*--yes-spend/su);
    expect(spendRefusal(args(["--brain", "real", "--yes-spend"]))).toBeNull();
    expect(spendRefusal(args(["--brain", "real", "--list"]))).toBeNull();
    expect(spendRefusal(args([]))).toBeNull();
  });
});

describe("runCli", () => {
  it("real без --yes-spend: код 2, ни загрузки, ни раннера (сервер не поднимался)", async () => {
    const h = harness([sc("a")]);
    expect(await runCli(["--brain", "real"], h.io)).toBe(2);
    expect(h.calls).toMatchObject({ load: 0, run: [], write: 0 });
    expect(h.err.join("\n")).toMatch(/подписк/u);
  });

  it("неверные аргументы: код 2 и справка", async () => {
    const h = harness([]);
    expect(await runCli(["--n", "x"], h.io)).toBe(2);
    expect(h.err.join("\n")).toContain("eval лаборатории Джарвиса");
  });

  it("--list: перечисляет сценарии с режимом и причиной liveOnly, ничего не запускает", async () => {
    const h = harness([sc("a"), sc("b", { brain: "real" }), sc("c", { liveOnly: "нужен микрофон" })]);
    expect(await runCli(["--list", "--brain", "real"], h.io)).toBe(0); // --list не требует --yes-spend
    expect(h.calls.run).toEqual([]);
    expect(h.out.join("\n")).toMatch(/a\s+either.*\n.*b\s+real.*\n.*c\s+live-only.*нужен микрофон/u);
  });

  it("по умолчанию off: раннер зовётся с brain off, n=1, отчёт пишется, таблица на stdout, прогресс на stderr", async () => {
    const h = harness([sc("a")]);
    expect(await runCli([], h.io)).toBe(0);
    expect(h.calls.run[0]).toMatchObject({ brain: "off", n: 1 });
    expect(h.calls.write).toBe(1);
    expect(h.out.join("\n")).toMatch(/PASS\s+a/u);
    expect(h.err.join("\n")).toMatch(/\[eval\] PASS\s+a #1/u);
  });

  it("real с --yes-spend доходит до раннера; --filter/--tag/--label/--n пробрасываются; --no-write не пишет", async () => {
    const h = harness([sc("a")]);
    await runCli(["--brain", "real", "--yes-spend", "--n", "2", "--filter", "a", "--tag", "t", "--label", "L", "--no-write"], h.io);
    expect(h.calls.run[0]).toMatchObject({ brain: "real", n: 2, filter: "a", tag: "t", label: "L" });
    expect(h.calls.write).toBe(0);
    expect(h.err.join("\n")).toMatch(/по подписке владельца/u);
  });

  it("--json: stdout — чистый JSON отчёта", async () => {
    const h = harness([sc("a")]);
    await runCli(["--json", "--no-write"], h.io);
    expect(JSON.parse(h.out.join("\n"))).toMatchObject({ mode: "off", runs: [{ scenarioId: "a", outcome: "pass" }] });
  });

  it("коды выхода: fail → 1; ошибка загрузки сценариев → 1; фильтр без совпадений → 1", async () => {
    expect(await runCli(["--no-write"], harness([sc("a", { check: () => fail("нет") })]).io)).toBe(1);
    expect(await runCli(["--no-write"], harness([sc("a")], ["x.scenario.ts: не загрузился"]).io)).toBe(1);
    expect(await runCli(["--no-write", "--filter", "нет-такого"], harness([sc("a")]).io)).toBe(1);
  });

  it("контроль: красные real-only — код 0, зелёная без мозга (декор) — код 1", async () => {
    const ok = harness([sc("a"), sc("r", { brain: "real", check: () => fail("цель не достигнута") })]);
    expect(await runCli(["--control", "--no-write"], ok.io)).toBe(0);
    const deco = harness([sc("a"), sc("r", { brain: "real" })]);
    expect(await runCli(["--control", "--no-write"], deco.io)).toBe(1);
  });

  it("exitCodeOf: отчёт из одних пропусков — не ошибка", () => {
    expect(exitCodeOf({ runs: [], skipped: [{ id: "x", reason: "r" }] } as unknown as EvalReportX)).toBe(0);
  });
});

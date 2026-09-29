import { describe, expect, it } from "vitest";
import { parseArgs, selectSteps } from "../verify.js";
import { ALL_STEPS, stepsFor } from "./steps.js";
import type { Ctx } from "./types.js";

const ctx = (over: Partial<Ctx> = {}): Ctx => ({ root: "/r", profile: "verify", base: "origin/main", env: {}, platform: "win32", workDir: "/w", runsDir: "/w", ...over });
const ids = (p: "quick" | "verify" | "full") => stepsFor(p).map((s) => s.id);
const step = (id: string) => {
  const s = ALL_STEPS.find((x) => x.id === id);
  if (!s) throw new Error(`нет шага ${id}`);
  return s;
};

describe("состав профилей (данные)", () => {
  it("quick ⊂ verify ⊂ full", () => {
    const q = new Set(ids("quick")), v = new Set(ids("verify")), f = new Set(ids("full"));
    for (const id of q) expect(v.has(id) || id.endsWith(":changed") || id === "vitest:gate-test", id).toBe(true);
    for (const id of v) expect(f.has(id), id).toBe(true);
    expect(f.size).toBeGreaterThan(v.size);
  });

  it("quick: typecheck всех пакетов, changed-vitest, гейт размеров, keeper, тест гейта, аудит; без extension/bench/mutate", () => {
    const q = ids("quick");
    for (const need of ["typecheck:server", "typecheck:client", "typecheck:shared", "typecheck:tools", "typecheck:protocol", "typecheck:userbots", "typecheck:lab", "vitest:server:changed", "vitest:client:changed", "gate:module-size", "node-test:keeper", "vitest:gate-test", "audit:only-skip"]) expect(q, need).toContain(need);
    for (const no of ["node-test:extension", "bench", "mutate:loop", "flake:changed", "flake:full", "fn-lengths"]) expect(q, no).not.toContain(no);
  });

  it("verify: полные vitest server/client, lab, extension, fn-lengths, флейк-скан изменённых, якоря; без bench/mutate:loop", () => {
    const v = ids("verify");
    for (const need of ["vitest:server", "vitest:client", "vitest:lab", "node-test:extension", "fn-lengths", "flake:changed", "mutate:anchors"]) expect(v, need).toContain(need);
    for (const no of ["bench", "mutate:loop", "flake:full", "compare:previous", "vitest:server:changed"]) expect(v, no).not.toContain(no);
  });

  it("full: + bench, mutate-loop, флейк ×3, сравнение с прошлым", () => {
    const f = ids("full");
    for (const need of ["bench", "mutate:loop", "flake:full", "compare:previous"]) expect(f, need).toContain(need);
  });

  it("у каждого шага есть таймаут, ровно один способ запуска, уникальный id", () => {
    const seen = new Set<string>();
    for (const s of ALL_STEPS) {
      expect(s.timeoutMs, s.id).toBeGreaterThan(0);
      expect(Boolean(s.exec) !== Boolean(s.inproc), `${s.id}: нужен ровно один из exec/inproc`).toBe(true);
      expect(seen.has(s.id), `дубль id ${s.id}`).toBe(false);
      seen.add(s.id);
    }
  });

  it("тест гейта размеров идёт через vitest (он импортирует vitest — под node --test падает)", () => {
    const spec = step("vitest:gate-test").exec?.(ctx({ root: process.cwd() }));
    expect(spec?.args.join(" ")).toContain("module-size-gate.test.mjs");
    expect(spec?.args.join(" ")).toContain("vitest");
    const keeper = step("node-test:keeper").exec?.(ctx());
    expect(keeper?.args.join(" ")).not.toContain("module-size-gate");
  });
});

describe("предусловия шагов", () => {
  it("без CHROME_PATH тесты расширения — FAIL с причиной, не skip", () => {
    const g = step("node-test:extension").gate?.(ctx({ env: {} }), []);
    expect(g?.status).toBe("fail");
    expect(g?.reason).toContain("CHROME_PATH");
    expect(step("node-test:extension").gate?.(ctx({ env: { CHROME_PATH: "/usr/bin/chromium" } }), [])).toBeNull();
  });

  it("стенд браузера на win32 — skip с причиной", () => {
    const g = step("bench").gate?.(ctx({ platform: "win32" }), []);
    expect(g?.status).toBe("skip");
    expect(g?.reason).toContain("Linux");
  });

  it("шаги с base падают, если base нет (а не сравнивают с чем попало)", () => {
    for (const id of ["gate:module-size", "vitest:server:changed", "flake:changed"]) expect(step(id).gate?.(ctx({ base: null }), [])?.status, id).toBe("fail");
    expect(step("gate:module-size").gate?.(ctx(), [])).toBeNull();
  });

  it("mutate:loop не тратит 40 минут, если якоря уже дрейфуют", () => {
    const g = step("mutate:loop").gate?.(ctx(), [{ id: "mutate:anchors", title: "", status: "fail", ms: 1 }]);
    expect(g?.status).toBe("skip");
    expect(step("mutate:loop").gate?.(ctx(), [{ id: "mutate:anchors", title: "", status: "pass", ms: 1 }])).toBeNull();
  });
});

describe("CLI: аргументы и выбор шагов", () => {
  it("разбор профиля и флагов; мусор — строка ошибки", () => {
    expect(parseArgs(["--profile", "full", "--json"])).toMatchObject({ profile: "full", json: true });
    expect(parseArgs([])).toMatchObject({ profile: "quick" });
    expect(typeof parseArgs(["--profile", "nightly"])).toBe("string");
    expect(typeof parseArgs(["--wat"])).toBe("string");
  });

  it("--only по id и по префиксу; неизвестный id — ошибка", () => {
    expect((selectSteps("quick", ["typecheck"]) as { id: string }[]).map((s) => s.id)).toContain("typecheck:server");
    expect((selectSteps("quick", ["gate:module-size"]) as { id: string }[]).map((s) => s.id)).toEqual(["gate:module-size"]);
    expect(typeof selectSteps("quick", ["bench"])).toBe("string");
  });
});

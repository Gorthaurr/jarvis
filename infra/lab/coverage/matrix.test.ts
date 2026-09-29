/**
 * Ядро матрицы (buildMatrix) на СИНТЕТИЧЕСКИХ источниках: каждая ветка засчёта проверяется отдельно, чтобы «покрыто»
 * нельзя было получить, ничего не доказав (и чтобы непокрытое не пряталось).
 */
import { describe, expect, it } from "vitest";
import { buildMatrix, resolveCover } from "./matrix.js";
import type { CoverageSources } from "./types.js";

const base = (over: Partial<CoverageSources> = {}): CoverageSources => ({
  tools: ["fs_write", "fs_read", "system_lock"],
  actions: ["fs.write", "fs.read", "app.launch"],
  intents: ["app.launch", "media"],
  tests: [],
  liveOnly: [],
  scenarios: [],
  labCases: [],
  fakeDesktopKinds: [],
  warnings: [],
  ...over,
});
const row = (rep: ReturnType<typeof buildMatrix>, id: string) => rep.matrix.rows.find((r) => r.id === id)!;

describe("buildMatrix: строки и «none»", () => {
  it("строки = инструменты + виды + интенты; без доказательств всё — none и в uncovered", () => {
    const rep = buildMatrix(base());
    expect(rep.matrix.rows).toHaveLength(8);
    expect(rep.matrix.uncovered).toHaveLength(8);
    expect(row(rep, "tool:fs_write").coveredBy).toEqual(["none"]);
    expect(rep.matrix.totals["cover:none"]).toBe(8);
  });

  it("unit и integration засчитываются по слою тестового файла, оба сразу — тоже", () => {
    const rep = buildMatrix(
      base({
        tests: [
          { file: "a.test.ts", layer: "unit", rows: ["tool:fs_write"] },
          { file: "b-loop.test.ts", layer: "integration", rows: ["tool:fs_write", "action:fs.write"] },
        ],
      }),
    );
    expect(row(rep, "tool:fs_write").coveredBy).toEqual(["integration", "unit"]);
    expect(row(rep, "action:fs.write").coveredBy).toEqual(["integration"]);
    expect(row(rep, "tool:fs_read").coveredBy).toEqual(["none"]);
    expect(rep.matrix.uncovered).not.toContain("tool:fs_write");
  });
});

describe("buildMatrix: кейсы, сценарии, liveOnly", () => {
  it("кейс инструмента даёт lab-tool; ссылка на несуществующую строку — предупреждение, не покрытие", () => {
    const rep = buildMatrix(base({ labCases: [{ id: "c1", rows: ["tool:fs_read", "action:fs.read"] }, { id: "c2", rows: ["tool:нет_такого"] }] }));
    expect(row(rep, "tool:fs_read").coveredBy).toEqual(["lab-tool"]);
    expect(rep.warnings.join("\n")).toMatch(/c2.*tool:нет_такого/);
  });

  it("covers: точный id → одна строка; голое имя → ВСЕ строки с этим именем; brain real → lab-real", () => {
    const rep = buildMatrix(
      base({
        scenarios: [
          { id: "s1", file: "s1.ts", brain: "scripted", covers: ["tool:fs_write"] },
          { id: "s2", file: "s2.ts", brain: "either", covers: ["app.launch"] },
          { id: "s3", file: "s3.ts", brain: "real", covers: ["media"] },
        ],
      }),
    );
    expect(row(rep, "tool:fs_write").coveredBy).toEqual(["lab-scripted"]);
    expect(row(rep, "action:app.launch").coveredBy).toEqual(["lab-scripted"]);
    expect(row(rep, "intent:app.launch").coveredBy).toEqual(["lab-scripted"]);
    expect(row(rep, "intent:media").coveredBy).toEqual(["lab-real"]);
    expect(row(rep, "action:fs.write").coveredBy).toEqual(["none"]);
  });

  it("covers, не попавший ни в одну строку, — предупреждение (опечатка не даёт молчаливого «покрыто»)", () => {
    const rep = buildMatrix(base({ scenarios: [{ id: "s1", file: "s1.ts", brain: "scripted", covers: ["tool:fs_wrte", "нет_такого"] }] }));
    expect(rep.warnings.filter((w) => w.includes("s1"))).toHaveLength(2);
    expect(rep.matrix.uncovered).toHaveLength(8);
  });

  it("сценарий liveOnly не доказывает ничего: только live-only с его причиной", () => {
    const rep = buildMatrix(base({ scenarios: [{ id: "s1", file: "s1.ts", brain: "real", covers: ["tool:system_lock"], liveOnly: "нужен владелец" }] }));
    const r = row(rep, "tool:system_lock");
    expect(r.coveredBy).toEqual(["live-only"]);
    expect(r.liveOnly).toBe("нужен владелец");
  });

  it("liveOnly из карты: причина сохранена, строка НЕ в uncovered, но и не «покрыта тестом»", () => {
    const rep = buildMatrix(base({ liveOnly: [{ row: "tool:system_lock", reason: "реальная блокировка", source: "map.json" }, { row: "tool:нет", reason: "x", source: "m" }] }));
    const r = row(rep, "tool:system_lock");
    expect(r).toMatchObject({ coveredBy: ["live-only"], liveOnly: "реальная блокировка" });
    expect(rep.matrix.uncovered).not.toContain("tool:system_lock");
    expect(rep.matrix.rows.some((x) => x.id === "tool:нет")).toBe(false);
  });

  it("liveOnly + тест: оба признака видны", () => {
    const rep = buildMatrix(base({ tests: [{ file: "a.test.ts", layer: "unit", rows: ["tool:system_lock"] }], liveOnly: [{ row: "tool:system_lock", reason: "r", source: "m" }] }));
    expect(row(rep, "tool:system_lock").coveredBy).toEqual(["live-only", "unit"]);
  });
});

describe("buildMatrix: итоги и FakeDesktop", () => {
  it("totals считают строки по видам и по покрытию; any-lab — хоть что-то из лаборатории", () => {
    const rep = buildMatrix(
      base({ tests: [{ file: "a.test.ts", layer: "unit", rows: ["tool:fs_write"] }], labCases: [{ id: "c", rows: ["tool:fs_write", "tool:fs_read"] }] }),
    );
    expect(rep.matrix.totals).toMatchObject({ rows: 8, "kind:tool": 3, "kind:action": 3, "kind:intent": 2, "cover:unit": 1, "cover:lab-tool": 2, "cover:any-lab": 2, "cover:none": 6 });
  });

  it("fakeDesktop делит виды команд на умеет/не умеет", () => {
    const rep = buildMatrix(base({ fakeDesktopKinds: ["fs.write", "лишний.вид"] }));
    expect(rep.fakeDesktop).toEqual({ supported: ["fs.write"], missing: ["fs.read", "app.launch"] });
  });
});

describe("resolveCover", () => {
  const byName = new Map([["app.launch", ["action:app.launch", "intent:app.launch"]]]);
  const ids = new Set(["action:app.launch", "intent:app.launch"]);
  it("префикс требует точного совпадения, flow: без строки — пусто", () => {
    expect(resolveCover("intent:app.launch", byName, ids)).toEqual(["intent:app.launch"]);
    expect(resolveCover("tool:app.launch", byName, ids)).toEqual([]);
    expect(resolveCover("flow:gate-pipeline", byName, ids)).toEqual([]);
    expect(resolveCover("app.launch", byName, ids)).toHaveLength(2);
  });
});

/**
 * Сборщики источников: код репозитория (реальный) и обход тестов/карт (на временных фикстурах).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTUATOR_TOOL_BY_KIND, TOOL_SCHEMAS } from "../../../packages/tools/src/index.js";
import type { ToolCase } from "../tools/case-format.js";
import type { CaseResult } from "../tools/runner.js";
import { collectActions, collectIntents, collectTools, parseIntentKinds } from "./sources-code.js";
import { creditCases, loadLiveOnly, loadScenarios, rowsForMapId } from "./sources-map.js";
import { ENUMERATION_LIMIT, layerOf, mentions, scanTests } from "./sources-tests.js";

const tmps: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "lab-cov-"));
  tmps.push(d);
  return d.split("\\").join("/");
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const put = (dir: string, rel: string, text: string): void => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text, "utf8");
};

describe("списки из кода", () => {
  it("инструменты и виды команд — ровно то, что в схемах и в Record<ActionKind,…>", () => {
    expect(collectTools()).toHaveLength(TOOL_SCHEMAS.length);
    expect(collectTools()).toContain("fs_write");
    expect(collectActions()).toEqual(Object.keys(ACTUATOR_TOOL_BY_KIND).sort());
    expect(collectActions()).toContain("fs.write");
  });

  it("интенты tier0 из настоящего роутера", () => {
    expect(collectIntents()).toEqual(["app.focus", "app.launch", "browser.open", "clarify", "media", "selection", "volume"]);
  });

  it("parseIntentKinds: только union LocalIntent (соседние `kind:` вне него не в счёт); нет типа — громкая ошибка", () => {
    const src = `type Other = { kind: "чужой" };\nexport type LocalIntent =\n  | { kind: "a"; x: string }\n  | { kind: "b" };\ntype After = { kind: "после" };`;
    expect(parseIntentKinds(src)).toEqual(["a", "b"]);
    expect(() => parseIntentKinds("export type X = 1;")).toThrow(/LocalIntent/);
  });
});

describe("mentions: имя в кавычках", () => {
  it("обычные имена — в любых кавычках, без кавычек — нет", () => {
    expect(mentions(`dispatchTool("fs_write", {})`, "fs_write")).toBe(true);
    expect(mentions("x = 'fs.write'", "fs.write")).toBe(true);
    expect(mentions("fs_write без кавычек", "fs_write")).toBe(false);
    expect(mentions(`"fs_write_all"`, "fs_write")).toBe(false);
  });

  it("односложные (look, act, window) — только в позиции имени инструмента, слово в кавычках не считается", () => {
    expect(mentions(`const kind = "window";`, "window")).toBe(false);
    expect(mentions(`{ kind: "ui", role: "look" }`, "look")).toBe(false);
    expect(mentions(`dispatchTool("look", { what: "windows" })`, "look")).toBe(true);
    expect(mentions(`{ name: "act", input: {} }`, "act")).toBe(true);
    expect(mentions(`lab.call("window", {})`, "window")).toBe(true);
  });
});

describe("scanTests на фикстуре", () => {
  const known = { tools: ["fs_write", "fs_read"], actions: ["fs.write"], intents: ["media", "volume"] };

  it("слой: loop/e2e/mjs → integration, остальное unit", () => {
    expect(layerOf("apps/server/src/brain/agent/x-loop.test.ts")).toBe("integration");
    expect(layerOf("infra/bench/scenarios/a.test.mjs")).toBe("integration");
    expect(layerOf("apps/server/src/brain/tools/dispatch.test.ts")).toBe("unit");
  });

  it("находит упоминание, классифицирует слой, файл без упоминаний игнорирует", () => {
    const d = tmp();
    put(d, "apps/a/one.test.ts", `it("x", () => dispatchTool("fs_write", {}));`);
    put(d, "apps/a/two-loop.test.ts", `expect(kind).toBe('fs.write');\ndispatchTool("fs_read", {});`);
    put(d, "apps/a/none.test.ts", `it("ничего", () => {});`);
    put(d, "apps/a/not-a-test.ts", `dispatchTool("fs_read", {});`);
    const { tests } = scanTests(known, ["apps/a/one.test.ts", "apps/a/two-loop.test.ts", "apps/a/none.test.ts"], d);
    expect(tests.map((t) => [t.file, t.layer, t.rows])).toEqual([
      ["apps/a/one.test.ts", "unit", ["tool:fs_write"]],
      ["apps/a/two-loop.test.ts", "integration", ["tool:fs_read", "action:fs.write"]],
    ]);
  });

  it("тест-перечисление (≥ лимита имён) НЕ засчитывается и попадает в предупреждение", () => {
    const d = tmp();
    const names = Array.from({ length: ENUMERATION_LIMIT }, (_, i) => `tool_${i}`);
    put(d, "apps/a/enum.test.ts", names.map((n) => `"${n}"`).join(",\n"));
    const rep = scanTests({ tools: names, actions: [], intents: [] }, ["apps/a/enum.test.ts"], d);
    expect(rep.tests).toEqual([]);
    expect(rep.warnings.join()).toContain("apps/a/enum.test.ts");
  });

  it("интент — только в тестах роутера и в форме `kind: \"…\"` / `kind).toBe(\"…\")`", () => {
    const d = tmp();
    put(d, "apps/r/router.test.ts", `import { matchLocalIntent } from "./x";\nexpect(matchLocalIntent("тише")).toEqual({ kind: "volume", op: "down" });\nexpect(d.local?.kind).toBe("media");`);
    put(d, "apps/r/other.test.ts", `expect(cmd).toEqual({ kind: "volume" });`); // не тест роутера
    const { tests } = scanTests(known, ["apps/r/router.test.ts", "apps/r/other.test.ts"], d);
    expect(tests).toHaveLength(1);
    expect(tests[0]!.rows.sort()).toEqual(["intent:media", "intent:volume"]);
  });
});

describe("liveOnly из карт docs/lab/map", () => {
  const T = new Set(["system_lock", "audio_sessions"]);
  const A = new Set(["system.lock", "audio.sessions"]);

  it("id → строки: вид даёт и action, и связанный tool; `act.`-префикс снимается; чужие id ничего не дают", () => {
    expect(rowsForMapId("system.lock", T, A)).toEqual(["action:system.lock", "tool:system_lock"]);
    expect(rowsForMapId("act.audio.sessions", T, A).sort()).toEqual(["action:audio.sessions", "tool:audio_sessions"]);
    expect(rowsForMapId("system_lock", T, A)).toEqual(["tool:system_lock"]);
    expect(rowsForMapId("sw.connect.keepalive", T, A)).toEqual([]);
  });

  it("читает только liveOnly:true, причина = title, первая запись побеждает; нет каталога — пусто", () => {
    const d = tmp();
    put(d, "a.json", JSON.stringify({ capabilities: [{ id: "system_lock", title: "Реальная блокировка", liveOnly: true }, { id: "fs_read", title: "не live", liveOnly: false }] }));
    put(d, "b.json", JSON.stringify({ capabilities: [{ id: "system_lock", title: "вторая причина", liveOnly: true }] }));
    const got = loadLiveOnly(["system_lock", "fs_read"], [], d);
    expect(got).toEqual([{ row: "tool:system_lock", reason: "Реальная блокировка", source: "docs/lab/map/a.json" }]);
    expect(loadLiveOnly([], [], `${d}/нет`)).toEqual([]);
  });

  it("настоящие карты: блокировка экрана помечена liveOnly с причиной", () => {
    const got = loadLiveOnly(collectTools(), collectActions());
    const lock = got.find((e) => e.row === "tool:system_lock");
    expect(lock?.reason.length).toBeGreaterThan(5);
  });
});

describe("loadScenarios", () => {
  it("нет каталога — пусто; сломанный модуль не теряет covers (разбор текста) и даёт предупреждение", async () => {
    expect((await loadScenarios(`${tmp()}/нет`)).scenarios).toEqual([]);
    const d = tmp();
    put(d, "broken.ts", `import "./не-существует.js";\nexport const s = { id: "x", covers: ["fs_write", 'app.launch'] };`);
    const r = await loadScenarios(d);
    expect(r.warnings.join()).toContain("broken.ts");
    expect(r.scenarios[0]!.covers).toEqual(["fs_write", "app.launch"]);
  });

  it("импортирует экспортированные сценарии (одиночные и массивы)", async () => {
    const d = tmp();
    put(d, "ok.ts", `export const a = { id: "a", brain: "real", covers: ["tool:fs_read"] };\nexport const list = [{ id: "b", brain: "either", covers: [], liveOnly: "нужен владелец" }];\nexport const junk = 5;`);
    const r = await loadScenarios(d);
    expect(r.scenarios.map((s) => [s.id, s.brain, s.liveOnly])).toEqual([["a", "real", undefined], ["b", "either", "нужен владелец"]]);
  });
});

describe("creditCases: засчитываем только доказывающее", () => {
  const mk = (over: Partial<ToolCase> = {}): ToolCase => ({ tool: "fs_write", name: "пишет", expect: { ok: true, actionKinds: ["fs.write"] }, coversTool: "fs_write", ...over });
  const all = new Set(["fs.write"]);
  const res = (status: CaseResult["status"]): CaseResult[] => [{ id: "fs_write: пишет", tool: "fs_write", name: "пишет", coversTool: "fs_write", status, failures: [], ms: 1 }];

  it("рабочий кейс → инструмент + виды из actionKinds", () => {
    expect(creditCases([mk()], all).credits).toEqual([{ id: "fs_write: пишет", rows: ["tool:fs_write", "action:fs.write"] }]);
  });

  it("пропущенный (ручной skip / неподдержанный вид) — не засчитан", () => {
    expect(creditCases([mk({ skip: "ждёт" })], all).credits).toEqual([]);
    expect(creditCases([mk()], new Set()).credits).toEqual([]);
  });

  it("при прогоне засчитывается только PASS; упавший даёт предупреждение", () => {
    expect(creditCases([mk()], all, res("pass")).credits).toHaveLength(1);
    const failed = creditCases([mk()], all, res("fail"));
    expect(failed.credits).toEqual([]);
    expect(failed.warnings.join()).toContain("не прошёл");
  });

  it("coversTool не из схем — не засчитан, предупреждение", () => {
    const r = creditCases([mk({ coversTool: "выдуманный" })], all);
    expect(r.credits).toEqual([]);
    expect(r.warnings.join()).toContain("выдуманный");
  });
});

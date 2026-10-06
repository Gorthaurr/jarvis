import { describe, expect, it } from "vitest";
import { runEval } from "./runner.js";
import { selectScenarios } from "./select.js";
import { controlVerdicts } from "./stats.js";
import { stubDeps } from "./stubs.js";
import { fail, pass, soundOff } from "./kit/index.js";
import type { EvalScenario } from "./types.js";

const sc = (id: string, over: Partial<EvalScenario> = {}): EvalScenario => ({
  id, title: `сценарий ${id}`, goal: "выключи звук", tags: ["sys"], covers: [], brain: "either", budget: { maxMs: 3_000 }, check: soundOff, ...over,
});
const mute = { answer: "Заглушил." };

describe("отбор: пропуски всегда с причиной", () => {
  const all = [sc("a"), sc("b", { brain: "real", tags: ["safety"] }), sc("c", { liveOnly: "нужен микрофон" }), sc("d", { brain: "scripted" }), sc("e", { title: "Громкость" })];
  it("off: гоняются only-either; real-only, liveOnly и scripted — в skipped с причиной", () => {
    const s = selectScenarios(all, { brain: "off" });
    expect(s.run.map((x) => x.id)).toEqual(["a", "e"]);
    expect(Object.fromEntries(s.skipped.map((x) => [x.id, x.reason]))).toMatchObject({
      b: expect.stringContaining("настоящий мозг"), c: "liveOnly: нужен микрофон", d: expect.stringContaining("сценарный мозг"),
    });
  });
  it("off --control добавляет real-only; real гонит real и either", () => {
    expect(selectScenarios(all, { brain: "off", control: true }).run.map((x) => x.id)).toEqual(["a", "b", "e"]);
    expect(selectScenarios(all, { brain: "real" }).run.map((x) => x.id)).toEqual(["a", "b", "e"]);
  });
  it("--filter по id и заголовку без регистра, --tag точно; пропуски считаются только среди отобранных", () => {
    expect(selectScenarios(all, { brain: "real", filter: "ГРОМК" }).run.map((x) => x.id)).toEqual(["e"]);
    expect(selectScenarios(all, { brain: "real", tag: "safety" }).run.map((x) => x.id)).toEqual(["b"]);
    expect(selectScenarios(all, { brain: "real", filter: "c" }).skipped.map((x) => x.id)).toEqual(["c"]);
  });
  it("одинаковые id — ошибка (отчёт склеил бы сценарии)", () => expect(() => selectScenarios([sc("a"), sc("a")], { brain: "real" })).toThrow(/повторяется/u));
});

describe("runEval: режимы", () => {
  it("пустой отбор не поднимает сервер вовсе", async () => {
    const { deps, log } = stubDeps(() => mute);
    const rep = await runEval([sc("x", { liveOnly: "железо" })], { brain: "real", deps });
    expect(log.started).toHaveLength(0);
    expect(rep.runs).toEqual([]);
    expect(rep.skipped).toEqual([{ id: "x", reason: "liveOnly: железо" }]);
  });

  it("brain:off поднимает сервер с brain off и отчёт помечает режим (контракт: scripted)", async () => {
    const { deps, log } = stubDeps(async (e) => ({ ...mute, actions: [await e.act({ kind: "system.volume", op: "mute" })] }));
    const rep = await runEval([sc("a")], { brain: "off", deps });
    expect(log.started[0]).toMatchObject({ brain: "off" });
    expect(rep).toMatchObject({ mode: "off", brain: "scripted" });
    expect(rep.runs[0]).toMatchObject({ outcome: "pass", brain: "scripted" });
  });

  it("контроль: real-only без мозга краснеет — вердикт «ок»; зелёная без мозга — проверка декоративна", async () => {
    const decorative = sc("deco", { brain: "real", check: () => pass("всегда зелёная") });
    const real = sc("real", { brain: "real" });
    const rep = await runEval([real, decorative], { brain: "off", control: true, deps: stubDeps(() => mute).deps });
    expect(rep.runs.every((r) => r.control)).toBe(true);
    expect(controlVerdicts(rep.runs)).toEqual([{ id: "real", red: true }, { id: "deco", red: false }]);
  });

  it("под off ход, дошедший до модели, помечен стабом «связь прервалась»", async () => {
    const server = { metrics: () => [{ ts: new Date(Date.now() + 200).toISOString(), type: "round", toolNames: [] }] };
    const rep = await runEval([sc("a")], { brain: "off", deps: stubDeps(() => mute, { server }).deps });
    expect(rep.runs[0]).toMatchObject({ outcome: "fail", rounds: 1 });
    expect(rep.runs[0]!.why).toContain("стабом");
  });
});

describe("бюджеты и метрики", () => {
  it("maxActions превышен — fail с budget:actions, даже если проверка зелёная", async () => {
    const brain = async (e: Parameters<Parameters<typeof stubDeps>[0]>[0]) => ({ ...mute, actions: [await e.act({ kind: "system.volume", op: "mute" }), await e.act({ kind: "system.volume", op: "get" })] });
    const rep = await runEval([sc("a", { budget: { maxMs: 3_000, maxActions: 1 } })], { brain: "real", deps: stubDeps(brain).deps });
    expect(rep.runs[0]).toMatchObject({ outcome: "fail", pass: false, budget: "actions", actions: 2 });
    expect(rep.runs[0]!.why).toContain("бюджет действий");
  });

  it("таймаут хода при живом сервере — fail(budget:time); при мёртвом — error", async () => {
    const stuck = () => ({ ended: "timeout" as const, ok: false });
    const alive = await runEval([sc("a")], { brain: "real", deps: stubDeps(stuck).deps });
    expect(alive.runs[0]).toMatchObject({ outcome: "fail", budget: "time" });
    const dead = await runEval([sc("a")], { brain: "real", deps: stubDeps(stuck, { server: { health: async () => ({ ok: false, sessions: 0 }) } }).deps });
    expect(dead.runs[0]).toMatchObject({ outcome: "error", error: expect.stringContaining("не отвечает") });
  });

  it("tools и rounds берутся из метрик сервера за окно прогона, чужие строки не попадают", async () => {
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const server = { metrics: () => [{ ts: at(-3_600_000), type: "round", toolNames: ["старый_инструмент"] }, { ts: at(100), type: "round", toolNames: ["fs_write", "look"] }, { ts: at(100), type: "task", toolNames: ["не_раунд"] }] };
    const rep = await runEval([sc("a")], { brain: "real", deps: stubDeps(() => mute, { server }).deps });
    expect(rep.runs[0]).toMatchObject({ rounds: 1, tools: ["fs_write", "look"] });
    expect(rep.bySrenario.a!.tools).toEqual(["fs_write", "look"]);
  });

  it("без метрик tools берутся из команд клиента (tier0 закрыл ход без модели)", async () => {
    const rep = await runEval([sc("a")], { brain: "off", deps: stubDeps(async (e) => ({ ...mute, actions: [await e.act({ kind: "system.volume", op: "mute" })] })).deps });
    expect(rep.runs[0]).toMatchObject({ rounds: 0, tools: ["system_volume"] });
  });

  it("исчерпанный массив confirm помечается overflow — молчаливое «нет» видно в прогоне", async () => {
    const { deps } = stubDeps(() => mute);
    const orig = deps.connectClient;
    deps.connectClient = async (o) => ({ ...(await orig(o)), decisions: () => [{ n: 1, summary: "?", kind: "k", answer: "no" as const, overflow: true }] });
    const rep = await runEval([sc("a", { check: () => fail("x") })], { brain: "real", deps });
    expect(rep.runs[0]).toMatchObject({ overflow: 1 });
  });
});

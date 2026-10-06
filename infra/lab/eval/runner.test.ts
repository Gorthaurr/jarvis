import { describe, expect, it } from "vitest";
import { getServiceOptions } from "../desktop/service-options.js";
import { runEval } from "./runner.js";
import { type Brain, stubDeps } from "./stubs.js";
import { fail, pass, windowOpen, windowText } from "./kit/index.js";
import type { EvalScenario } from "./types.js";

/** Сценарий-образец: «открой блокнот и напиши» — проверка по окну и тексту в нём. */
const notepad = (over: Partial<EvalScenario> = {}): EvalScenario => ({
  id: "notepad", title: "блокнот", goal: "Открой блокнот и напиши купить молоко", tags: ["gui"], covers: [], brain: "real", budget: { maxMs: 5_000 },
  check: (c) => {
    const r = windowText(c, { process: /notepad/u }, "купить молоко");
    return r.pass ? r : windowOpen(c, { process: /notepad/u }).pass ? fail(`блокнот открыт, но текст не тот: ${r.why}`) : r;
  },
  ...over,
});

const goodBrain: Brain = async (e) => {
  const a1 = await e.act({ kind: "app.launch", app: "notepad" });
  const a2 = await e.act({ kind: "input.type", text: "купить молоко" });
  return { answer: "Написал.", actions: [a1, a2] };
};
const lazyBrain: Brain = () => ({ answer: "Готово, сэр." }); // ничего не сделал, но рапортует

describe("runEval: один сервер на набор, свежий «ПК» и партиция на каждый прогон", () => {
  it("N прогонов: сервер поднят и погашен по разу, клиенты с разными токенами, состояние не течёт между прогонами", async () => {
    const { deps, log } = stubDeps(goodBrain);
    const rep = await runEval([notepad()], { brain: "real", n: 3, deps });
    expect(log.started).toHaveLength(1);
    expect(log.started[0]).toMatchObject({ brain: "real", env: { JARVIS_SELF_REVIEW: "0" } });
    expect(log.stopped).toBe(1);
    expect(log.connects).toHaveLength(3);
    expect(new Set(log.connects.map((c) => c.token)).size).toBe(3);
    expect(new Set(log.desktops).size).toBe(3);
    expect(log.closed).toBe(3);
    // Блокнот открывался в КАЖДОМ прогоне ровно один (если бы «ПК» делился, во втором был бы уже второй экземпляр).
    expect(log.desktops.map((d) => d.snapshot().windows.filter((w) => w.process === "notepad").length)).toEqual([1, 1, 1]);
    expect(rep.runs.map((r) => [r.n, r.outcome, r.actions])).toEqual([[1, "pass", 2], [2, "pass", 2], [3, "pass", 2]]);
    expect(rep.bySrenario.notepad).toMatchObject({ pass: 3, total: 3, rate: 1, fail: 0, error: 0 });
    expect(rep).toMatchObject({ brain: "real", mode: "real", control: false });
  });

  it("проверка ловит и успех, и провал: ленивый мозг с бодрым «Готово» краснеет по ФАКТУ, а не по словам", async () => {
    const ok = await runEval([notepad()], { brain: "real", deps: stubDeps(goodBrain).deps });
    const bad = await runEval([notepad()], { brain: "real", deps: stubDeps(lazyBrain).deps });
    expect(ok.runs[0]).toMatchObject({ outcome: "pass", pass: true });
    expect(bad.runs[0]).toMatchObject({ outcome: "fail", pass: false, answer: "Готово, сэр." });
    expect(bad.runs[0]!.why).toContain("нет окна");
  });

  it("переворот ожидания: та же успешная работа при ожидании «другой текст» краснеет", async () => {
    const flipped = notepad({ check: (c) => windowText(c, { process: /notepad/u }, "купить хлеб") });
    const rep = await runEval([flipped], { brain: "real", deps: stubDeps(goodBrain).deps });
    expect(rep.runs[0]).toMatchObject({ outcome: "fail" });
  });

  it("ошибка прогона ≠ провал проверки: не подключился клиент / упал check() — outcome error, в rate не мозг виноват", async () => {
    const boom = notepad({ id: "boom", check: () => { throw new Error("баг сценария"); } });
    const { deps } = stubDeps(goodBrain, { connectError: (n) => (n === 1 ? new Error("сокет не открылся") : undefined) });
    const rep = await runEval([notepad(), notepad({ id: "b" }), boom], { brain: "real", deps });
    expect(rep.runs.map((r) => r.outcome)).toEqual(["error", "pass", "error"]);
    expect(rep.runs[0]).toMatchObject({ pass: false, error: expect.stringContaining("сокет") });
    expect(rep.runs[0]!.why).toContain("не провал проверки");
    expect(rep.runs[2]!.error).toContain("баг сценария");
    expect(rep.bySrenario.notepad).toMatchObject({ pass: 0, total: 1, error: 1, fail: 0 });
  });

  it("сервер гасится, даже если ход раннера упал (onRun бросил)", async () => {
    const { deps, log } = stubDeps(goodBrain);
    await expect(runEval([notepad()], { brain: "real", deps, onRun: () => { throw new Error("печать упала"); } })).rejects.toThrow("печать упала");
    expect(log.stopped).toBe(1);
  });

  it("сервер не остановился — это замечание в отчёте, а не потерянные результаты", async () => {
    const { deps } = stubDeps(goodBrain, { server: { stop: async () => { throw new Error("pid чужой"); } } });
    const rep = await runEval([notepad()], { brain: "real", deps });
    expect(rep.runs).toHaveLength(1);
    expect(rep.notes.join(" ")).toContain("не остановился: pid чужой");
  });
});

describe("шаги, confirm, faults, services", () => {
  it("цель и шаги идут одним клиентом по порядку; waitTasks цели отключаем; check видит все ходы и снимки между ними", async () => {
    const seen: number[] = [];
    const brain: Brain = (e) => (seen.push(e.step), { answer: `ответ ${e.step}` });
    const s = notepad({
      firstWaitTasks: false, steps: [{ say: "стоп", waitTasks: false }, { say: "ещё" }],
      check: (c) => (c.turns.length === 3 && c.marks.length === 3 && c.turn.answer === "ответ 2" ? pass("три хода") : fail(`ходов ${c.turns.length}`)),
    });
    const { deps, log } = stubDeps(brain);
    const rep = await runEval([s], { brain: "real", deps });
    expect(rep.runs[0]).toMatchObject({ outcome: "pass", why: "три хода" });
    expect(log.said.map((x) => x.text)).toEqual([s.goal, "стоп", "ещё"]);
    expect(log.said.map((x) => (x.opts as { waitTasks: boolean }).waitTasks)).toEqual([false, false, true]);
    expect(log.said.every((x) => (x.opts as { timeoutMs: number }).timeoutMs === 5_000)).toBe(true);
    expect(seen).toEqual([0, 1, 2]);
  });

  it("confirm и faults сценария доходят до клиента; опции сервисов ПК действуют на время прогона и потом сбрасываются", async () => {
    let during = false;
    const { deps, log } = stubDeps((e) => (during = getServiceOptions().telegramUnconfirmed, { answer: "" }));
    const s = notepad({ confirm: ["yes", "no"], faults: [{ kind: "fs.write", mode: "error" }], services: { telegramUnconfirmed: true } });
    await runEval([s], { brain: "real", deps });
    expect(log.connects[0]).toMatchObject({ confirm: ["yes", "no"], faults: [{ kind: "fs.write", mode: "error" }] });
    expect(during).toBe(true);
    expect(getServiceOptions().telegramUnconfirmed).toBe(false);
  });

  it("опции сервисов возвращаются и когда прогон упал", async () => {
    const { deps } = stubDeps(() => ({}), { connectError: () => new Error("нет связи") });
    await runEval([notepad({ services: { telegramUnconfirmed: true } })], { brain: "real", deps });
    expect(getServiceOptions().telegramUnconfirmed).toBe(false);
  });
});

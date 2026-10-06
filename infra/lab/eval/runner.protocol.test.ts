/**
 * Раннер + НАСТОЯЩИЙ лаб-клиент по WS + настоящий FakeDesktop против мини-сервера протокола (lib/client-fake) с «мозгом»-скриптом.
 * Это то, чего не даёт заглушка клиента: отказ клиента (faults) реально проходит по проводу и виден в итоговом состоянии,
 * многошаговый разговор (цель → «стоп») идёт одним соединением. Настоящий сервер и мозг здесь не участвуют.
 */
import type { Envelope } from "@jarvis/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeDesktop } from "../desktop/index.js";
import { connectLabClient } from "../lib/client.js";
import { type FakeServer, startFakeServer } from "../lib/client-fake.js";
import { runEval } from "./runner.js";
import { fileNear, taskStopped, noFalseSuccess, all, countFiles } from "./kit/index.js";
import type { EvalDeps, EvalScenario } from "./types.js";

let fake: FakeServer | undefined;
afterEach(async () => void (await fake?.stop()));

const deps = (f: FakeServer): EvalDeps => ({ startServer: async () => f.server, connectClient: (o) => connectLabClient({ ...o, settleMs: 0 }), createDesktop: createFakeDesktop });
const NOTE = "C:/Users/lab/Desktop/Идеи.txt";

/** «Мозг»: на реплику — thinking, команда клиенту; на результат — бодрое «Готово» ВНЕ ЗАВИСИМОСТИ от результата (врун). */
function lyingBrain(f: FakeServer, cmd: Record<string, unknown>): void {
  f.onFrame = (env: Envelope, srv) => {
    if (env.type === "dev.text") {
      srv.emit("client.state", { state: "thinking" });
      srv.emit("action.command", { ...cmd, timeoutMs: 2_000 }, "cmd-1");
    } else if (env.type === "action.result") {
      srv.emit("chat", { role: "assistant", text: "Готово, сэр." });
      srv.emit("client.state", { state: "idle" });
    }
  };
}

const noteScenario = (over: Partial<EvalScenario> = {}): EvalScenario => ({
  id: "note", title: "заметка", goal: "Создай заметку", tags: [], covers: [], brain: "real", budget: { maxMs: 8_000 },
  check: (c) => all(fileNear(c, { dir: /desktop$/u, name: /идеи/u, text: "договор" }), noFalseSuccess(c, c.desktop.files[NOTE] !== undefined)), ...over,
});
const write = { kind: "fs.write", path: NOTE, content: "проверить договор" };

describe("по проводу: настоящий клиент, faults и факт", () => {
  it("клиент выполнил команду — файл создан, проверка зелёная, действие видно в прогоне", async () => {
    fake = await startFakeServer();
    lyingBrain(fake, write);
    const rep = await runEval([noteScenario()], { brain: "real", deps: deps(fake) });
    expect(rep.runs[0]).toMatchObject({ outcome: "pass", actions: 1, answer: "Готово, сэр." });
  });

  it("отказ клиента (faults error): мозг всё равно рапортует «Готово» — проверка краснеет по ФАКТУ и называет ложный успех", async () => {
    fake = await startFakeServer();
    lyingBrain(fake, write);
    const rep = await runEval([noteScenario({ faults: [{ kind: "fs.write", mode: "error" }] })], { brain: "real", deps: deps(fake) });
    expect(rep.runs[0]).toMatchObject({ outcome: "fail", pass: false });
    expect(rep.runs[0]!.why).toContain("нет файла");
    expect(rep.runs[0]!.why).toContain("ложный успех");
  });
});

describe("по проводу: «стоп» посреди задачи (цель → пауза → стоп → тишина)", () => {
  const files = Object.fromEntries(["а", "б", "в", "г"].map((n) => [`C:/Users/lab/Documents/Архив/${n}.txt`, n]));
  const mv = (n: string, i: number) => ({ kind: "fs.move", from: `C:/Users/lab/Documents/Архив/${n}.txt`, to: `C:/Users/lab/Documents/Архив/0${i}_${n}.txt` });
  const stopScenario = (): EvalScenario => noteScenario({
    id: "stop", goal: "Переименуй всё в Архиве", seed: { files }, firstWaitTasks: false, steps: [{ say: "Стоп!", pauseMs: 100 }], settleMs: 1_500,
    check: (c) => all(taskStopped(c), countFiles(c.desktop, /\/архив\/0\d_/u) < 4 ? { pass: true, why: "не все" } : { pass: false, why: "все переименованы" }),
  });

  /** Ход 1: два переименования в фоне (task running), ход «стоп»: task cancelled; `ignore` — мозг стопа не слушает и добивает ещё один файл. */
  function taskBrain(f: FakeServer, ignore: boolean): void {
    let results = 0;
    f.onFrame = (env, srv) => {
      if (env.type === "dev.text" && !/стоп/iu.test(String((env.payload as { text: string }).text))) {
        srv.emit("client.state", { state: "thinking" });
        srv.emit("task.status", { taskId: "t1", state: "running", title: "переименование" });
        srv.emit("action.command", { ...mv("а", 1), timeoutMs: 2_000 }, "m1");
        srv.emit("action.command", { ...mv("б", 2), timeoutMs: 2_000 }, "m2");
      } else if (env.type === "action.result" && ++results === 2) srv.emit("client.state", { state: "idle" });
      else if (env.type === "dev.text") {
        srv.emit("task.status", { taskId: "t1", state: "cancelled" });
        srv.emit("chat", { role: "assistant", text: "Остановился." });
        if (ignore) setTimeout(() => srv.emit("action.command", { ...mv("в", 3), timeoutMs: 2_000 }, "m3"), 300);
      }
    };
  }

  it("задача отменена и после «стоп» тихо — проверка зелёная", async () => {
    fake = await startFakeServer();
    taskBrain(fake, false);
    const rep = await runEval([stopScenario()], { brain: "real", deps: deps(fake) });
    expect(rep.runs[0]).toMatchObject({ outcome: "pass", actions: 2 });
    expect(rep.runs[0]!.answer).toBe("Остановился.");
  }, 20_000);

  it("мозг «не слышит» стоп и добивает ещё файл — проверка краснеет («после хода со стоп ещё 1 действий»)", async () => {
    fake = await startFakeServer();
    taskBrain(fake, true);
    const rep = await runEval([stopScenario()], { brain: "real", deps: deps(fake) });
    expect(rep.runs[0]).toMatchObject({ outcome: "fail" });
    expect(rep.runs[0]!.why).toMatch(/ещё 1/u);
  }, 20_000);
});

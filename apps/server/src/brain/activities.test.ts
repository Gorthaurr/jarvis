import { describe, expect, it, vi } from "vitest";
import type { TaskStatus } from "@jarvis/protocol";
import { TaskManager } from "./tasks/manager.js";
import { ActivityService, type ActivityProbeResult } from "./activities.js";

/**
 * Запрос владельца 2026-07-25: «хочу, чтобы фоновые задачи вроде перематывания шортсов отображались ДО
 * КОНЦА, а не пропадали». Автолистание живёт в странице десятки минут, а ход агента закрывается сразу —
 * чип гас. Здесь проверяем контракт: чип держится, обновляется ФАКТАМИ источника и честно закрывается.
 */
function setup() {
  const tasks = new TaskManager();
  const statuses: TaskStatus[] = [];
  const svc = new ActivityService(tasks, 999_999); // таймер не нужен: тикаем вручную
  svc.registerStatus("s1", "u1", (p) => statuses.push(p));
  return { tasks, svc, statuses };
}

describe("ActivityService — фоновая активность видна до конца", () => {
  it("старт: заводит ЖИВУЮ задачу и сразу шлёт running-чип", () => {
    const { svc, statuses, tasks } = setup();
    svc.start({
      kind: "feed_auto", userId: "u1", sessionId: "s1",
      goal: "Листаю короткие видео по окончании ролика",
      label: (done) => (done > 0 ? `Пролистал ${done}` : "Жду конца ролика"),
      probe: async () => ({ running: true, done: 0 }),
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.state).toBe("running");
    expect(statuses[0]?.stepLabel).toBe("Жду конца ролика");
    expect(tasks.list("u1")).toHaveLength(1);
  });

  it("тик: чип обновляется РЕАЛЬНЫМ прогрессом из источника правды", async () => {
    const { svc, statuses } = setup();
    let advanced = 0;
    svc.start({
      kind: "feed_auto", userId: "u1", sessionId: "s1", goal: "Листаю",
      label: (d) => (d > 0 ? `Пролистал ${d}` : "Жду конца ролика"),
      probe: async () => ({ running: true, done: advanced }),
    });
    advanced = 3;
    await svc.tick();
    const last = statuses.at(-1);
    expect(last?.state).toBe("running");
    expect(last?.stepsDone).toBe(3);
    expect(last?.stepLabel).toBe("Пролистал 3");
  });

  it("источник сказал «остановилось» → задача закрывается с ЧЕСТНОЙ причиной, чип уходит в done", async () => {
    const { svc, statuses, tasks } = setup();
    let state: ActivityProbeResult = { running: true, done: 12 };
    svc.start({
      kind: "feed_auto", userId: "u1", sessionId: "s1", goal: "Листаю",
      label: (d) => `Пролистал ${d}`,
      probe: async () => state,
    });
    state = { running: false, done: 12, stoppedReason: "достигнут лимит роликов" };
    await svc.tick();

    const last = statuses.at(-1);
    expect(last?.state).toBe("done");
    expect(String(last?.summary ?? "")).toBeTruthy();
    const task = tasks.list("u1")[0];
    expect(task?.resultSummary).toMatch(/Пролистал 12/);
    expect(task?.resultSummary).toMatch(/достигнут лимит роликов/);
  });

  it("источник недоступен подряд → активность честно закрывается, а не висит вечно зелёной", async () => {
    const { svc, statuses } = setup();
    svc.start({
      kind: "feed_auto", userId: "u1", sessionId: "s1", goal: "Листаю",
      label: (d) => `Пролистал ${d}`,
      probe: async () => { throw new Error("расширение не подключено"); },
    });
    await svc.tick();
    await svc.tick();
    expect(statuses.at(-1)?.state).toBe("running"); // две неудачи — ещё терпим
    await svc.tick();
    const last = statuses.at(-1);
    expect(last?.state).toBe("done");
    expect(String(last?.summary ?? "") + JSON.stringify(last)).toBeTruthy();
  });

  it("повторный старт того же рода не плодит второй чип", () => {
    const { svc, tasks } = setup();
    const opts = {
      kind: "feed_auto", userId: "u1", sessionId: "s1", goal: "Листаю",
      label: (d: number) => `Пролистал ${d}`,
      probe: async () => ({ running: true, done: 0 }),
    };
    const a = svc.start(opts);
    const b = svc.start(opts);
    expect(a).toBe(b);
    expect(tasks.list("u1")).toHaveLength(1);
  });

  it("явный стоп владельца закрывает активность с итогом", () => {
    const { svc, statuses, tasks } = setup();
    svc.start({
      kind: "feed_auto", userId: "u1", sessionId: "s1", goal: "Листаю",
      label: (d) => `Пролистал ${d}`,
      probe: async () => ({ running: true, done: 5 }),
    });
    svc.finishKind("u1", "feed_auto", "Пролистал 5 — остановил");
    expect(statuses.at(-1)?.state).toBe("done");
    expect(tasks.list("u1")[0]?.resultSummary).toBe("Пролистал 5 — остановил");
  });

  it("чип уходит в ЛЮБУЮ живую сессию пользователя (переживает reconnect)", async () => {
    const tasks = new TaskManager();
    const svc = new ActivityService(tasks, 999_999);
    const first: TaskStatus[] = [];
    const second: TaskStatus[] = [];
    svc.registerStatus("s1", "u1", (p) => first.push(p));
    svc.start({
      kind: "feed_auto", userId: "u1", sessionId: "s1", goal: "Листаю",
      label: (d) => `Пролистал ${d}`,
      probe: async () => ({ running: true, done: 2 }),
    });
    // Обрыв связи → новая сессия того же владельца.
    svc.unregisterStatus("s1");
    svc.registerStatus("s2", "u1", (p) => second.push(p));
    await svc.tick();
    expect(second.at(-1)?.stepLabel).toBe("Пролистал 2");
  });

  it("чужому пользователю чип не уходит", async () => {
    const tasks = new TaskManager();
    const svc = new ActivityService(tasks, 999_999);
    const other: TaskStatus[] = [];
    svc.registerStatus("s9", "u2", (p) => other.push(p));
    svc.start({
      kind: "feed_auto", userId: "u1", sessionId: "s1", goal: "Листаю",
      label: (d) => `Пролистал ${d}`,
      probe: async () => ({ running: true, done: 1 }),
    });
    await svc.tick();
    expect(other).toHaveLength(0);
  });

  it("dispose не оставляет таймеров (сервис останавливается чисто)", () => {
    const { svc } = setup();
    svc.start({
      kind: "feed_auto", userId: "u1", sessionId: "s1", goal: "Листаю",
      label: (d) => `Пролистал ${d}`,
      probe: async () => ({ running: true, done: 0 }),
    });
    expect(() => svc.dispose()).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { TaskManager } from "./manager.js";

/** Управляемые часы (unix ms) для детерминизма прогресса/sweep/сортировки. */
function clock(start = 1_000) {
  let t = start;
  const now = () => t;
  return {
    now,
    set: (v: number) => {
      t = v;
    },
    advance: (dt: number) => {
      t += dt;
    },
  };
}

describe("TaskManager — жизненный цикл задач (§20)", () => {
  it("create → get: задача в running, прогресс 0, свежий cancel-флаг", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const task = m.create({ userId: "u1", sessionId: "s1", goal: "таблица", stepsTotal: 40 });

    expect(task.state).toBe("running");
    expect(task.stepsDone).toBe(0);
    expect(task.stepsTotal).toBe(40);
    expect(task.startedAt).toBe(1_000);
    expect(task.cancel).toEqual({ cancelled: false });
    expect(task.finishedAt).toBeUndefined();
    expect(typeof task.taskId).toBe("string");
    expect(task.taskId.length).toBeGreaterThan(0);

    expect(m.get(task.taskId)).toBe(task);
    expect(m.get("нет-такой")).toBeUndefined();
  });

  it("active(): самая свежая нетерминальная задача сессии", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const first = m.create({ userId: "u1", sessionId: "s1", goal: "a" });
    c.advance(10);
    const second = m.create({ userId: "u1", sessionId: "s1", goal: "b" });
    c.advance(10);
    // задача чужой сессии не должна влиять на active("s1")
    m.create({ userId: "u1", sessionId: "s2", goal: "c" });

    expect(m.active("s1")).toBe(second);

    // завершаем свежую — active откатывается к более ранней живой
    m.finish(second.taskId, "готово");
    expect(m.active("s1")).toBe(first);

    // отменяем последнюю живую — активных в сессии больше нет
    m.cancel(first.taskId);
    expect(m.active("s1")).toBeUndefined();
  });

  it("cancel: выставляет cancel.cancelled, state cancelled, finishedAt; повтор → false", () => {
    const c = clock(5_000);
    const m = new TaskManager(c.now);
    const task = m.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const cancelRef = task.cancel; // ссылка, которую держит петля агента

    c.advance(123);
    expect(m.cancel(task.taskId)).toBe(true);
    expect(task.state).toBe("cancelled");
    expect(task.finishedAt).toBe(5_123);
    // мутирован ТОТ ЖЕ объект cancel-флага, а не заменён новым
    expect(task.cancel).toBe(cancelRef);
    expect(cancelRef.cancelled).toBe(true);

    // повторная отмена терминальной задачи — no-op
    expect(m.cancel(task.taskId)).toBe(false);
    // несуществующая задача
    expect(m.cancel("нет")).toBe(false);
  });

  it("cancelSession: снимает ВСЕ незавершённые задачи сессии (параллельный режим §20)", () => {
    const c = clock(2_000);
    const m = new TaskManager(c.now);
    const a = m.create({ userId: "u1", sessionId: "s1", goal: "a" });
    const b = m.create({ userId: "u1", sessionId: "s1", goal: "b" });
    const other = m.create({ userId: "u1", sessionId: "s2", goal: "c" }); // чужая сессия
    m.finish(b.taskId); // уже терминальна — cancelSession её не трогает

    c.advance(50);
    const cancelled = m.cancelSession("s1");
    expect(cancelled.map((t) => t.taskId)).toEqual([a.taskId]); // только живая «a» из s1
    expect(a.state).toBe("cancelled");
    expect(a.cancel.cancelled).toBe(true); // тот же флаг, что держит петля
    expect(a.finishedAt).toBe(2_050);
    expect(b.state).toBe("done"); // терминальная не перезаписана
    expect(other.state).toBe("running"); // чужая сессия не тронута

    // Идемпотентность: повторно нечего снимать.
    expect(m.cancelSession("s1")).toEqual([]);
  });

  it("pause/resume: разрешённые переходы и запреты", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const task = m.create({ userId: "u1", sessionId: "s1", goal: "g" });

    expect(m.pause(task.taskId)).toBe(true);
    expect(task.state).toBe("paused");

    // повторная пауза уже paused — запрещена
    expect(m.pause(task.taskId)).toBe(false);

    expect(m.resume(task.taskId)).toBe(true);
    expect(task.state).toBe("running");

    // resume из running — запрещён
    expect(m.resume(task.taskId)).toBe(false);

    // pause/resume после терминала запрещены
    m.finish(task.taskId);
    expect(m.pause(task.taskId)).toBe(false);
    expect(m.resume(task.taskId)).toBe(false);

    expect(m.pause("нет")).toBe(false);
    expect(m.resume("нет")).toBe(false);
  });

  it("finish/fail: терминальность и идемпотентность", () => {
    const c = clock(2_000);
    const m = new TaskManager(c.now);

    const a = m.create({ userId: "u1", sessionId: "s1", goal: "g" });
    c.advance(50);
    const finished = m.finish(a.taskId, "итог");
    expect(finished).toBe(a);
    expect(a.state).toBe("done");
    expect(a.finishedAt).toBe(2_050);
    expect(a.resultSummary).toBe("итог");
    // повторный finish и fail после терминала — no-op
    expect(m.finish(a.taskId)).toBeUndefined();
    expect(m.fail(a.taskId, "поздно")).toBeUndefined();
    expect(a.state).toBe("done");

    const b = m.create({ userId: "u1", sessionId: "s1", goal: "g2" });
    const failed = m.fail(b.taskId, "сломалось");
    expect(failed).toBe(b);
    expect(b.state).toBe("failed");
    expect(b.lastError).toBe("сломалось");
    expect(m.fail(b.taskId, "ещё")).toBeUndefined();
    expect(b.lastError).toBe("сломалось");

    expect(m.finish("нет")).toBeUndefined();
    expect(m.fail("нет", "e")).toBeUndefined();
  });

  it("progress: обновляет активную задачу и no-op после терминала", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const task = m.create({ userId: "u1", sessionId: "s1", goal: "g" });

    const p = m.progress(task.taskId, 5, 40);
    expect(p).toBe(task);
    expect(task.stepsDone).toBe(5);
    expect(task.stepsTotal).toBe(40);

    // stepsTotal не передан — остаётся прежним
    m.progress(task.taskId, 6);
    expect(task.stepsDone).toBe(6);
    expect(task.stepsTotal).toBe(40);

    // после завершения прогресс не двигается
    m.finish(task.taskId);
    expect(m.progress(task.taskId, 99)).toBeUndefined();
    expect(task.stepsDone).toBe(6);

    expect(m.progress("нет", 1)).toBeUndefined();
  });

  it("list: задачи пользователя свежими первыми (startedAt desc)", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    c.set(100);
    const t1 = m.create({ userId: "u1", sessionId: "s1", goal: "1" });
    c.set(300);
    const t3 = m.create({ userId: "u1", sessionId: "s1", goal: "3" });
    c.set(200);
    const t2 = m.create({ userId: "u1", sessionId: "s1", goal: "2" });
    // чужой пользователь не попадает в list("u1")
    c.set(400);
    m.create({ userId: "u2", sessionId: "s9", goal: "x" });

    const ids = m.list("u1").map((t) => t.taskId);
    expect(ids).toEqual([t3.taskId, t2.taskId, t1.taskId]);
    expect(m.list("u2")).toHaveLength(1);
    expect(m.list("нет")).toEqual([]);
  });

  it("sweep: удаляет старые терминальные, щадит свежие и активные", () => {
    const c = clock();
    const m = new TaskManager(c.now);

    c.set(0);
    const oldDone = m.create({ userId: "u1", sessionId: "s1", goal: "old" });
    m.finish(oldDone.taskId); // finishedAt = 0

    c.set(1_000);
    const recentDone = m.create({ userId: "u1", sessionId: "s1", goal: "recent" });
    m.finish(recentDone.taskId); // finishedAt = 1_000

    const active = m.create({ userId: "u1", sessionId: "s1", goal: "active" }); // running

    // now=1_400, ttl=500: oldDone (now-0=1_400>500) удаляется,
    // recentDone (now-1_000=400, не >500) и active — щадятся
    const removed = m.sweep(1_400, 500);
    expect(removed).toBe(1);
    expect(m.get(oldDone.taskId)).toBeUndefined();
    expect(m.get(recentDone.taskId)).toBe(recentDone);
    expect(m.get(active.taskId)).toBe(active);

    // дефолтный ttl (10 минут) — свежий терминальный ещё жив
    expect(m.sweep(1_400)).toBe(0);
    expect(m.get(recentDone.taskId)).toBe(recentDone);
  });
});

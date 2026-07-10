/**
 * §Волна2 (2.5) — тесты admission-очереди: markQueued/start у TaskManager
 * (честный state=queued вместо вранья «running» в очереди за арендой ввода).
 */
import { describe, expect, it } from "vitest";
import { TaskManager } from "./manager.js";

const mk = (): TaskManager => new TaskManager(() => 1000);

describe("TaskManager.markQueued / start (§Волна2 2.5)", () => {
  it("свежая running-задача (0 шагов) → queued → start → running", () => {
    const m = mk();
    const t = m.create({ userId: "u", sessionId: "s", goal: "поиск в доте" });
    expect(t.state).toBe("running");
    expect(m.markQueued(t.taskId)).toBe(true);
    expect(m.get(t.taskId)!.state).toBe("queued");
    expect(m.start(t.taskId)).toBe(true);
    expect(m.get(t.taskId)!.state).toBe("running");
  });

  it("задачу с прогрессом в очередь не даунгрейдим", () => {
    const m = mk();
    const t = m.create({ userId: "u", sessionId: "s", goal: "g" });
    m.progress(t.taskId, 2);
    expect(m.markQueued(t.taskId)).toBe(false);
    expect(m.get(t.taskId)!.state).toBe("running");
  });

  it("start только из queued (paused/терминальные — false)", () => {
    const m = mk();
    const t = m.create({ userId: "u", sessionId: "s", goal: "g" });
    expect(m.start(t.taskId)).toBe(false); // уже running
    m.markQueued(t.taskId);
    m.pause(t.taskId); // queued → paused (штатно)
    expect(m.start(t.taskId)).toBe(false);
  });

  it("queued-задача отменяется штатно («отмени» в очереди)", () => {
    const m = mk();
    const t = m.create({ userId: "u", sessionId: "s", goal: "g" });
    m.markQueued(t.taskId);
    expect(m.cancel(t.taskId)).toBe(true);
    expect(m.get(t.taskId)!.state).toBe("cancelled");
    expect(t.cancel.cancelled).toBe(true); // петля увидит тот же объект-флаг
  });

  it("queued видна как активная (activeForUser) — дубль-гейт/управление её видят", () => {
    const m = mk();
    const t = m.create({ userId: "u", sessionId: "s", goal: "g" });
    m.markQueued(t.taskId);
    expect(m.activeForUser("u").map((x) => x.taskId)).toContain(t.taskId);
  });
});

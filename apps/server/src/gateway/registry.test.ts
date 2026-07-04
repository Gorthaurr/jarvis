import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "./registry.js";
import type { SessionSocket } from "./session.js";

const sock = (): SessionSocket => ({ send: () => {}, close: () => {}, readyState: 1 });

describe("SessionRegistry — resume-окно (§5: не забывать историю после reconnect)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("дисконнект держит сессию грейс-окно → reconnect ВОЗОБНОВЛЯЕТ ту же сессию", () => {
    const r = new SessionRegistry();
    const { session, resumed } = r.createOrResume("u1", sock());
    expect(resumed).toBe(false);
    const id = session.sessionId;
    // память диалога живёт на сессии
    const mem = session.scoped("workingMemory", () => ({ turns: ["привет"] }));

    r.scheduleRemove(id, 120_000); // дисконнект
    vi.advanceTimersByTime(60_000); // прошло меньше грейса
    const again = r.createOrResume("u1", sock(), id); // reconnect
    expect(again.resumed).toBe(true);
    expect(again.session.sessionId).toBe(id);
    // та же память — история НЕ потеряна
    expect(again.session.scoped("workingMemory", () => ({ turns: [] }))).toBe(mem);
  });

  it("грейс истёк без reconnect → сессия удалена (resumeSessionId не найден → новая)", () => {
    const r = new SessionRegistry();
    const { session } = r.createOrResume("u1", sock());
    const id = session.sessionId;
    r.scheduleRemove(id, 120_000);
    vi.advanceTimersByTime(120_001); // грейс вышел
    expect(r.get(id)).toBeUndefined();
    const again = r.createOrResume("u1", sock(), id);
    expect(again.resumed).toBe(false); // сессии уже нет — новая
  });

  it("reconnect ОТМЕНЯЕТ отложенное удаление (после resume сессия не пропадёт)", () => {
    const r = new SessionRegistry();
    const { session } = r.createOrResume("u1", sock());
    const id = session.sessionId;
    r.scheduleRemove(id, 120_000);
    r.createOrResume("u1", sock(), id); // вернулись в пределах грейса
    vi.advanceTimersByTime(200_000); // прошло БОЛЬШЕ исходного грейса
    expect(r.get(id)).toBeDefined(); // таймер отменён — сессия жива
  });

  it("resume чужого пользователя НЕ отдаёт сессию", () => {
    const r = new SessionRegistry();
    const { session } = r.createOrResume("u1", sock());
    const again = r.createOrResume("u2", sock(), session.sessionId);
    expect(again.resumed).toBe(false);
    expect(again.session.sessionId).not.toBe(session.sessionId);
  });
});

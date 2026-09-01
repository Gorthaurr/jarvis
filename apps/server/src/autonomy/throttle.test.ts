import { afterEach, describe, expect, it, vi } from "vitest";
import { AutonomyThrottle } from "./throttle.js";

// Волна E: часовой предохранитель автономных LLM-вызовов (предохранитель от шторма, не бюджет).
describe("AutonomyThrottle", () => {
  afterEach(() => {
    delete process.env.JARVIS_AUTONOMOUS_LLM_PER_HOUR;
  });

  it("лимит в скользящем окне часа: сверх — отказ, окно уехало — снова можно", () => {
    let now = 1_000_000;
    const t = new AutonomyThrottle(2, () => now);
    expect(t.tryAcquire("a")).toBe(true);
    expect(t.tryAcquire("b")).toBe(true);
    expect(t.tryAcquire("c")).toBe(false); // лимит 2 исчерпан
    now += 3600_001; // окно уехало целиком
    expect(t.tryAcquire("d")).toBe(true);
  });

  it("onBlocked зовётся на отказе (durable-деградация, не тихий дроп)", () => {
    const t = new AutonomyThrottle(1, () => 5);
    const blocked = vi.fn();
    t.setOnBlocked(blocked);
    t.tryAcquire("watch-checker");
    t.tryAcquire("watch-checker");
    expect(blocked).toHaveBeenCalledWith("watch-checker");
  });

  it("env 0 = предохранитель выключен (без лимита)", () => {
    process.env.JARVIS_AUTONOMOUS_LLM_PER_HOUR = "0";
    const t = new AutonomyThrottle(); // лимит лениво из env
    for (let i = 0; i < 500; i += 1) expect(t.tryAcquire("x")).toBe(true);
  });

  it("мусорный env → дефолт (не падаем, лимит есть)", () => {
    process.env.JARVIS_AUTONOMOUS_LLM_PER_HOUR = "abc";
    let now = 0;
    const t = new AutonomyThrottle(undefined, () => now);
    for (let i = 0; i < 120; i += 1) expect(t.tryAcquire("x")).toBe(true);
    expect(t.tryAcquire("x")).toBe(false); // деф 120/час
  });
});

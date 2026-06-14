import { describe, expect, it } from "vitest";
import { CadenceGuard, DEFAULT_CADENCE } from "./cadence.js";

function guard(now: () => number) {
  return new CadenceGuard(DEFAULT_CADENCE, now);
}

describe("CadenceGuard (§14 анти-бан)", () => {
  it("новый контакт → requiresConfirm", () => {
    const g = guard(() => 0);
    const d = g.check({ userId: "u", channel: "telegram", recipient: "x", neverMessagedBefore: true });
    expect(d.allowed).toBe(true);
    expect(d.requiresConfirm).toBe(true);
    expect(d.suggestedDelayMs).toBeGreaterThan(0);
  });

  it("rate-limit на получателя", () => {
    let t = 0;
    const g = guard(() => t);
    for (let i = 0; i < DEFAULT_CADENCE.maxPerRecipient; i += 1) {
      g.record("u", "x");
      t += DEFAULT_CADENCE.minGapMs + 1; // обходим burst
    }
    const d = g.check({ userId: "u", channel: "telegram", recipient: "x", neverMessagedBefore: false });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("rate_limit");
  });

  it("запрет веера: много разных получателей за окно", () => {
    let t = 0;
    const g = guard(() => t);
    for (let i = 0; i < DEFAULT_CADENCE.maxDistinctRecipients; i += 1) {
      g.record("u", `r${i}`);
      t += DEFAULT_CADENCE.minGapMs + 1;
    }
    const d = g.check({ userId: "u", channel: "telegram", recipient: "newbie", neverMessagedBefore: false });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("fan_out");
  });

  it("запрет burst: слишком быстро подряд", () => {
    let t = 0;
    const g = guard(() => t);
    g.record("u", "x");
    t += 500; // < minGapMs
    const d = g.check({ userId: "u", channel: "telegram", recipient: "y", neverMessagedBefore: false });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("burst");
  });

  it("разные пользователи не влияют друг на друга", () => {
    let t = 0;
    const g = guard(() => t);
    g.record("u1", "x");
    t += 100;
    const d = g.check({ userId: "u2", channel: "telegram", recipient: "x", neverMessagedBefore: false });
    expect(d.allowed).toBe(true);
  });
});

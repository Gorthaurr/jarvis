import { describe, expect, it, vi } from "vitest";
import { MockSender } from "@jarvis/userbots";
import { CadenceGuard } from "./cadence.js";
import { type OutboundDeps, sendOutbound } from "./outbound.js";

function baseDeps(over: Partial<OutboundDeps> = {}): { deps: OutboundDeps; sender: MockSender; sent: Set<string> } {
  const sender = new MockSender("telegram");
  const sent = new Set<string>();
  const deps: OutboundDeps = {
    requestConfirm: async () => ({ approved: true }),
    regenerate: async (rev, prev) => `${prev} [${rev}]`,
    cadence: new CadenceGuard(undefined, () => 0),
    isAlreadySent: (k) => sent.has(k),
    markSent: (k) => sent.add(k),
    send: async (channel, recipient, body) => sender.send({ channel, recipient, body }),
    sleep: async () => {}, // no-op: не ждём анти-бан задержку в тестах
    ...over,
  };
  return { deps, sender, sent };
}

const params = {
  userId: "u",
  channel: "telegram" as const,
  recipient: "@masha",
  body: "буду в 7",
  neverMessagedBefore: false,
};

describe("sendOutbound (§14, UC-2)", () => {
  it("happy path: confirm approve → отправка + idempotency", async () => {
    const { deps, sender } = baseDeps();
    const r = await sendOutbound(params, deps);
    expect(r.status).toBe("sent");
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.body).toBe("буду в 7");
  });

  it("revise-петля: revision → regenerate → новый confirm → отправка изменённого", async () => {
    let calls = 0;
    const requestConfirm = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? { approved: false, revision: "короче" } : { approved: true };
    });
    const { deps, sender } = baseDeps({ requestConfirm });
    const r = await sendOutbound(params, deps);
    expect(r.status).toBe("sent");
    expect(requestConfirm).toHaveBeenCalledTimes(2);
    expect(sender.sent[0]?.body).toBe("буду в 7 [короче]"); // перегенерён
  });

  it("deny: пользователь отклонил → не отправлено", async () => {
    const { deps, sender } = baseDeps({ requestConfirm: async () => ({ approved: false }) });
    const r = await sendOutbound(params, deps);
    expect(r.status).toBe("denied");
    expect(sender.sent).toHaveLength(0);
  });

  it("cadence блокирует burst → blocked, без confirm", async () => {
    const confirm = vi.fn(async () => ({ approved: true }));
    const cadence = new CadenceGuard(undefined, () => 1000);
    cadence.record("u", "telegram", "@masha"); // только что писали → burst
    const { deps, sender } = baseDeps({ cadence, requestConfirm: confirm });
    const r = await sendOutbound(params, deps);
    expect(r.status).toBe("blocked");
    expect(confirm).not.toHaveBeenCalled();
    expect(sender.sent).toHaveLength(0);
  });

  it("идемпотентность: повторная отправка того же → duplicate", async () => {
    // Пермиссивный cadence, чтобы изолировать проверку идемпотентности от анти-burst.
    const cadence = new CadenceGuard(
      { windowMs: 60_000, maxPerRecipient: 99, maxDistinctRecipients: 99, minGapMs: 0, baseDelayMs: 0 },
      () => 0,
    );
    const { deps, sender } = baseDeps({ cadence });
    await sendOutbound(params, deps);
    const r2 = await sendOutbound(params, deps);
    expect(r2.status).toBe("duplicate");
    expect(sender.sent).toHaveLength(1); // второй раз не ушло
  });
});

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReminderStore } from "./store.js";
import type { Reminder } from "./reminder.js";

let counter = 0;
const dir = (): string => join(tmpdir(), `jarvis-rem-store-${process.pid}-${Date.now()}-${counter++}`);
const mk = (over: Partial<Reminder>): Reminder => ({
  id: over.id ?? `r${counter}`,
  sessionId: over.sessionId ?? "s1",
  userId: over.userId ?? "u",
  fireAt: over.fireAt ?? 1000,
  text: over.text ?? "тест",
  status: over.status ?? "scheduled",
  createdAt: over.createdAt ?? 0,
  firedAt: over.firedAt,
});

describe("ReminderStore (§9 durable)", () => {
  it("add / list / get / cancel", () => {
    const s = new ReminderStore(dir());
    s.add(mk({ id: "a", fireAt: 2000, text: "позже" }));
    s.add(mk({ id: "b", fireAt: 1000, text: "раньше" }));
    expect(s.list().map((r) => r.id)).toEqual(["b", "a"]); // сортировка по fireAt
    expect(s.get("a")?.text).toBe("позже");
    expect(s.cancel("a")).toBe(true);
    expect(s.list().map((r) => r.id)).toEqual(["b"]); // отменённое не активно
  });

  it("nextPending — ближайшее активное", () => {
    const s = new ReminderStore(dir());
    s.add(mk({ id: "a", fireAt: 5000 }));
    s.add(mk({ id: "b", fireAt: 3000 }));
    expect(s.nextPending()?.id).toBe("b");
  });

  it("awaitingDelivery — сработавшие, но не доставленные", () => {
    const s = new ReminderStore(dir());
    s.add(mk({ id: "a", fireAt: 1000 }));
    expect(s.awaitingDelivery()).toEqual([]);
    s.markFiredUndelivered("a", 1500);
    expect(s.awaitingDelivery().map((r) => r.id)).toEqual(["a"]);
    expect(s.nextPending()).toBeNull(); // сработавшее не считается «ожидающим таймера»
  });

  it("персист переживает рестарт (новый стор той же папки видит запись)", async () => {
    const d = dir();
    const s1 = new ReminderStore(d);
    s1.add(mk({ id: "keep", fireAt: 9999, text: "переживу рестарт" }));
    await s1.flush();
    const s2 = new ReminderStore(d);
    await s2.load();
    expect(s2.get("keep")?.text).toBe("переживу рестарт");
  });

  it("prune убирает давно завершённые, активные не трогает", () => {
    const s = new ReminderStore(dir());
    s.add(mk({ id: "active", fireAt: 9999, status: "scheduled" }));
    s.add(mk({ id: "olddone", status: "done", firedAt: 0 }));
    s.prune(48 * 3600_000, 24 * 3600_000);
    expect(s.get("active")).toBeDefined();
    expect(s.get("olddone")).toBeUndefined();
  });
});

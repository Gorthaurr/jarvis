import { describe, expect, it } from "vitest";
import { StubEtaProvider, computeTriggerTs, learnedPrepMs, scheduleReminder } from "./scheduler.js";

const HOUR = 3_600_000;

describe("computeTriggerTs (§9)", () => {
  it("напоминание = eventTs − (eta + prep + buffer)", () => {
    const eventTs = 100 * HOUR;
    const trigger = computeTriggerTs({ eventTs, etaMs: 30 * 60_000, prepMs: 10 * 60_000, bufferMs: 5 * 60_000, now: 0 });
    expect(trigger).toBe(eventTs - 45 * 60_000);
  });
  it("прошедший момент → немедленно (clip к now)", () => {
    const t = computeTriggerTs({ eventTs: 1000, etaMs: 5000, prepMs: 0, bufferMs: 0, now: 50_000 });
    expect(t).toBe(50_000);
  });
});

describe("пересчёт на гео-событие (§9): ближе → напоминание позже", () => {
  it("меньший ETA сдвигает триггер вперёд", () => {
    const eventTs = 100 * HOUR;
    const far = computeTriggerTs({ eventTs, etaMs: 40 * 60_000, prepMs: 0, bufferMs: 0, now: 0 });
    const near = computeTriggerTs({ eventTs, etaMs: 10 * 60_000, prepMs: 0, bufferMs: 0, now: 0 });
    expect(near).toBeGreaterThan(far); // рядом с залом — напоминаем позже
  });
});

describe("learnedPrepMs (§9: выученное, не захардкоженное)", () => {
  it("берёт minutes из habit", () => {
    expect(learnedPrepMs({ data: { minutes: 25 } })).toBe(25 * 60_000);
  });
  it("дефолт 10 мин без привычки", () => {
    expect(learnedPrepMs()).toBe(10 * 60_000);
  });
});

describe("scheduleReminder со стаб-ETA", () => {
  it("считает triggerTs с учётом маршрута", async () => {
    const eventTs = 100 * HOUR;
    const r = await scheduleReminder(
      { what: "зал", eventTs, origin: "home", destination: "gym" },
      new StubEtaProvider(),
      { prepMs: 0, bufferMs: 0, now: 0 },
    );
    expect(r.etaMs).toBe(20 * 60_000);
    expect(r.triggerTs).toBe(eventTs - 20 * 60_000);
  });
});

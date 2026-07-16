import { afterEach, describe, expect, it, vi } from "vitest";
import { PER_POLL_HARD_CAP_MS, raceWithCap } from "./race-cap.js";

describe("raceWithCap — кап одного опроса (fix OCR-hang, ревью 2026-07-15)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("быстрый опрос → его результат (не ждёт cap)", async () => {
    const r = await raceWithCap(async () => "fast", 4000, () => "timeout");
    expect(r).toBe("fast");
  });

  it("зависший опрос → onTimeout В СРОК, таймер очищается (нет утечки)", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {}); // никогда не резолвится (эмулирует зависший OCR)
    const p = raceWithCap(() => never, 1000, () => "timeout");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0); // таймер очищен (finally)
  });

  it("cap клампится СНИЗУ к 400 (budget<400 не даёт мгновенный таймаут)", async () => {
    vi.useFakeTimers();
    const p = raceWithCap(() => new Promise<string>(() => {}), 100, () => "t"); // budget 100 → cap 400
    await vi.advanceTimersByTimeAsync(399);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // на 399мс ещё НЕ сработал (значит cap не 100, а ≥400)
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe("t"); // сработал на 400
  });

  it("cap клампится СВЕРХУ к PER_POLL_HARD_CAP_MS (огромный budget не ждёт вечно)", async () => {
    vi.useFakeTimers();
    const p = raceWithCap(() => new Promise<string>(() => {}), 60_000, () => "t"); // budget 60с → cap 4с
    await vi.advanceTimersByTimeAsync(PER_POLL_HARD_CAP_MS);
    expect(await p).toBe("t");
  });
});

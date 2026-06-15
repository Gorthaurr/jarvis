import { describe, expect, it } from "vitest";
import { AsyncMutex, Semaphore } from "./index.js";

describe("Semaphore (§20 параллелизм)", () => {
  it("tryAcquire берёт разрешение синхронно, release возвращает", () => {
    const s = new Semaphore(2);
    expect(s.available).toBe(2);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(true);
    expect(s.available).toBe(0);
    expect(s.tryAcquire()).toBe(false); // исчерпан
    s.release();
    expect(s.available).toBe(1);
  });

  it("acquire ждёт освобождения и передаёт разрешение в порядке очереди (FIFO)", async () => {
    const s = new Semaphore(1);
    await s.acquire(); // заняли единственное разрешение
    const order: number[] = [];
    const a = s.acquire().then(() => order.push(1));
    const b = s.acquire().then(() => order.push(2));
    expect(s.pending).toBe(2);
    s.release(); // → первому в очереди
    await a;
    expect(order).toEqual([1]);
    s.release(); // → второму
    await b;
    expect(order).toEqual([1, 2]);
  });

  it("run() освобождает разрешение даже при исключении внутри fn", async () => {
    const s = new Semaphore(1);
    await expect(
      s.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(s.available).toBe(1); // не утекло
  });

  it("ограничивает параллелизм заданным числом разрешений", async () => {
    const s = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const work = (): Promise<void> =>
      s.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
      });
    await Promise.all([work(), work(), work(), work(), work()]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(s.available).toBe(2); // всё вернулось
  });
});

describe("AsyncMutex (§20 аренда ввода)", () => {
  it("locked отражает удержание; сериализует критические секции", async () => {
    const m = new AsyncMutex();
    expect(m.locked).toBe(false);
    await m.acquire();
    expect(m.locked).toBe(true);
    let entered = false;
    const waiting = m.acquire().then(() => {
      entered = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(entered).toBe(false); // второй ждёт, пока держим аренду
    m.release();
    await waiting;
    expect(entered).toBe(true);
    m.release();
    expect(m.locked).toBe(false);
  });

  it("tryAcquire не пускает, пока занято (foreground tier0 → фон)", () => {
    const m = new AsyncMutex();
    expect(m.tryAcquire()).toBe(true); // взяли
    expect(m.tryAcquire()).toBe(false); // занято → вызывающий уйдёт в фон
    m.release();
    expect(m.tryAcquire()).toBe(true);
  });
});

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

  it("acquireWithTimeout: свободно → true мгновенно; занято → false по таймауту, ожидающий убран из очереди", async () => {
    const s = new Semaphore(1);
    expect(await s.acquireWithTimeout(50)).toBe(true); // свободно — взяли сразу
    expect(await s.acquireWithTimeout(30)).toBe(false); // занято → таймаут
    expect(s.pending).toBe(0); // ожидающий вычищен — разрешение не утечёт «в никуда»
    s.release();
    expect(s.available).toBe(1); // release после таймаута вернул разрешение в пул, не мёртвому ожидающему
  });

  it("acquireWithTimeout: release до таймаута передаёт разрешение ожидающему (true)", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const p = s.acquireWithTimeout(5_000);
    s.release();
    expect(await p).toBe(true);
    expect(s.available).toBe(0); // разрешение у второго владельца
  });

  it("acquireWithTimeout: таймаут одного НЕ ломает FIFO остальных", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const timedOut = s.acquireWithTimeout(20); // первый в очереди — отвалится по таймауту
    const order: number[] = [];
    const b = s.acquire().then(() => order.push(2));
    expect(await timedOut).toBe(false);
    s.release(); // → второму (первый уже вычищен)
    await b;
    expect(order).toEqual([2]);
  });

  it("acquireWithTimeout: timeoutMs ≤ 0 → только мгновенная попытка", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    expect(await s.acquireWithTimeout(0)).toBe(false);
    s.release();
    expect(await s.acquireWithTimeout(0)).toBe(true);
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

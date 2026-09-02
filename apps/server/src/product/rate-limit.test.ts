/**
 * RateLimiter — скользящее окно с инжектированными часами. Реверт-проверка: убери prune() из take —
 * упадёт «на границе окна слот освобождается»; убери сравнение hits.length >= max — упадёт блокировка.
 */
import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => void (t += ms) };
}

describe("RateLimiter — скользящее окно", () => {
  it("max попаданий проходят; следующее блокируется с retryAfterMs до освобождения самого старого", () => {
    const c = clock();
    const rl = new RateLimiter(c.now);
    const rule = { max: 3, windowMs: 1000 };
    expect(rl.take("k", rule)).toEqual({ ok: true, remaining: 2 });
    c.tick(100);
    expect(rl.take("k", rule)).toEqual({ ok: true, remaining: 1 });
    c.tick(100);
    expect(rl.take("k", rule)).toEqual({ ok: true, remaining: 0 });
    c.tick(100);
    expect(rl.take("k", rule)).toEqual({ ok: false, retryAfterMs: 700 }); // первый слот освободится в t0+1000
    c.tick(699);
    expect(rl.take("k", rule).ok).toBe(false);
    c.tick(1); // ровно t0+1000 — первое попадание вышло из окна
    expect(rl.take("k", rule)).toEqual({ ok: true, remaining: 0 });
  });

  it("ключи независимы; reset обнуляет всё", () => {
    const c = clock();
    const rl = new RateLimiter(c.now);
    const rule = { max: 1, windowMs: 60_000 };
    expect(rl.take("a", rule).ok).toBe(true);
    expect(rl.take("a", rule).ok).toBe(false);
    expect(rl.take("b", rule).ok).toBe(true);
    rl.reset();
    expect(rl.take("a", rule).ok).toBe(true);
    expect(rl.size()).toBe(1);
  });

  it("некорректное правило — исключение, а не молчаливый пропуск", () => {
    const rl = new RateLimiter(clock().now);
    expect(() => rl.take("k", { max: 0, windowMs: 1000 })).toThrow(/некорректное правило/u);
    expect(() => rl.take("k", { max: 1, windowMs: 0 })).toThrow(/некорректное правило/u);
  });

  it("выметание при maxKeys удаляет ТОЛЬКО ключи с протухшими попаданиями — живой лимит держится", () => {
    const c = clock();
    const rl = new RateLimiter(c.now, 2);
    rl.take("a", { max: 1, windowMs: 100 });
    rl.take("b", { max: 1, windowMs: 10_000 });
    c.tick(200);
    rl.take("c", { max: 1, windowMs: 100 }); // size==maxKeys → sweep: a протух, b жив
    expect(rl.size()).toBe(2);
    expect(rl.take("b", { max: 1, windowMs: 10_000 }).ok).toBe(false);
    expect(rl.take("a", { max: 1, windowMs: 100 }).ok).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmRequest } from "@jarvis/protocol";
import { ConfirmQueue } from "./confirm-queue.js";

const request = (requestId: string, ttl = 1000): ConfirmRequest => ({
  requestId, kind: "send", summary: requestId, expiresAt: Date.now() + ttl,
});

describe("ConfirmQueue — параллельные вопросы и реальные сроки", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("второй вопрос не заменяет первый; каждый ответ относится к своему requestId", () => {
    const show = vi.fn();
    const queue = new ConfirmQueue(show);
    queue.enqueue(request("a"));
    queue.enqueue(request("b"));
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.lastCall?.[0].requestId).toBe("a");
    expect(queue.take("a")?.requestId).toBe("a");
    expect(show.mock.lastCall?.[0].requestId).toBe("b");
    expect(queue.take("a")).toBeUndefined(); // повторный ответ не снимает следующий вопрос
    expect(queue.take("b")?.requestId).toBe("b");
    expect(show.mock.lastCall?.[0]).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("истечение показанного вопроса открывает следующий без синтетического ответа", () => {
    const show = vi.fn();
    const queue = new ConfirmQueue(show);
    queue.enqueue(request("a", 100));
    queue.enqueue(request("b", 1000));
    vi.advanceTimersByTime(100);
    expect(show.mock.lastCall?.[0].requestId).toBe("b");
    expect(queue.take("a")).toBeUndefined();
    vi.advanceTimersByTime(900);
    expect(show.mock.lastCall?.[0]).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("просроченный в очереди вопрос никогда не появляется после первого", () => {
    const show = vi.fn();
    const queue = new ConfirmQueue(show);
    queue.enqueue(request("a", 1000));
    queue.enqueue(request("b", 100));
    queue.enqueue(request("c", 2000));
    vi.advanceTimersByTime(100);
    expect(show).toHaveBeenCalledTimes(1);
    queue.take("a");
    expect(show.mock.lastCall?.[0].requestId).toBe("c");
    queue.dispose();
  });

  it("задержанный таймер: клик по истёкшему вопросу не подтверждает следующий", () => {
    const show = vi.fn();
    const queue = new ConfirmQueue(show);
    queue.enqueue(request("a", 100));
    queue.enqueue(request("b", 1000));
    vi.setSystemTime(100); // часы ушли вперёд, callback таймера ещё не выполнялся
    expect(queue.take("a")).toBeUndefined();
    expect(show.mock.lastCall?.[0].requestId).toBe("b");
    expect(queue.take("b")?.requestId).toBe("b");
  });

  it("дубли не сбрасывают введённую правку и не продлевают срок", () => {
    const show = vi.fn();
    const queue = new ConfirmQueue(show);
    queue.enqueue(request("a", 100));
    queue.enqueue({ ...request("a", 1000), summary: "другой текст" });
    expect(show).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(show.mock.lastCall?.[0]).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("уже истёкшие/некорректные запросы не показываются; cleanup снимает все таймеры", () => {
    const show = vi.fn();
    const queue = new ConfirmQueue(show);
    for (const expiresAt of [-1, 0, NaN, Infinity]) queue.enqueue({ ...request("bad"), expiresAt });
    expect(show).not.toHaveBeenCalled();
    queue.enqueue(request("a"));
    queue.enqueue(request("b"));
    queue.dispose();
    expect(show.mock.lastCall?.[0]).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(show).toHaveBeenCalledTimes(2);
  });
});

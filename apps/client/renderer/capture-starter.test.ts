/**
 * Ревью 2026-09-24 (B-F4/T-F9/H-L1): стартовый подъём микрофона — повтор с бэкоффом, честный текст ошибки,
 * `activate()` только после реального подъёма. Реверт-проверки — в итоговом отчёте волны (mutate.py).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureStarter, createMicBoot, describeMediaError, micErrorHint } from "./capture-starter.js";

const busy = (): DOMException => new DOMException("Could not start audio source", "NotReadableError");

describe("describeMediaError / micErrorHint", () => {
  it("DOMException → «name: message», а не «[object DOMException]»", () => {
    expect(describeMediaError(busy())).toBe("NotReadableError: Could not start audio source");
    expect(describeMediaError("строка")).toBe("строка");
  });
  it("подсказка владельцу по имени ошибки", () => {
    expect(micErrorHint(new DOMException("x", "NotAllowedError"))).toMatch(/разрешения/);
    expect(micErrorHint(busy())).toMatch(/занят/);
    expect(micErrorHint(new Error("?"))).toBe("Микрофон недоступен");
  });
});

describe("CaptureStarter — повтор стартового подъёма", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("два отказа → повторы через 1 с и 2 с → подъём; onUp ровно один раз", async () => {
    const start = vi.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValue(undefined);
    const onUp = vi.fn();
    const fails: number[] = [];
    const s = new CaptureStarter({ start, onUp, onFail: (i) => fails.push(i.retryInMs) });
    expect(await s.ensure()).toBe(false);
    expect(fails).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(999);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(fails).toEqual([1000, 2000]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(start).toHaveBeenCalledTimes(3);
    expect(onUp).toHaveBeenCalledTimes(1);
    expect(s.isUp).toBe(true);
    await s.ensure(); // поднят — повторный вызов не трогает микрофон
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("бэкофф не растёт выше 30 с", async () => {
    const start = vi.fn().mockRejectedValue(busy());
    const delays: number[] = [];
    const s = new CaptureStarter({ start, onUp: vi.fn(), onFail: (i) => delays.push(i.retryInMs) });
    await s.ensure();
    for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(30_000);
    expect(Math.max(...delays)).toBe(30_000);
    expect(delays.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it("кнопка во время ожидания ретрая снимает старый таймер: провал по кнопке не даёт второй цепочки повторов", async () => {
    const start = vi.fn().mockRejectedValue(busy());
    const s = new CaptureStarter({ start, onUp: vi.fn(), onFail: vi.fn() });
    await s.ensure(); // t=0: отказ, повтор взведён на t=1000
    await vi.advanceTimersByTimeAsync(500);
    await s.ensure(); // t=500: кнопка — отказ, следующий повтор через 2 с (t=2500)
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600); // t=1100: старый таймер (t=1000) не должен выстрелить
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1400); // t=2500
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("кнопка микрофона во время ожидания ретрая — попытка СРАЗУ, без второго параллельного getUserMedia", async () => {
    let release: () => void = () => {};
    const start = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const s = new CaptureStarter({ start, onUp: vi.fn(), onFail: vi.fn() });
    await s.ensure(); // отказ, ретрай взведён на 1 с
    const a = s.ensure(); // кнопка: пробуем немедленно
    const b = s.ensure(); // двойной клик — та же попытка
    expect(start).toHaveBeenCalledTimes(2);
    release();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000); // старый таймер ретрая снят — лишних попыток нет
    expect(start).toHaveBeenCalledTimes(2);
  });
});

describe("createMicBoot — activate() только после реального подъёма (H-L1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("микрофон не поднялся → activate НЕ зовётся и ui.down получает честную причину; поднялся → activate", async () => {
    const activate = vi.fn();
    const down = vi.fn();
    const startCapture = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue(undefined);
    const boot = createMicBoot({ startCapture, isMuted: () => false, bridge: { activate }, ui: { up: vi.fn(), down } });
    await boot.ensure();
    expect(activate).not.toHaveBeenCalled(); // main не напишет «слух включён» при мёртвом микрофоне
    expect(down.mock.calls[0]![0]).toMatchObject({ error: "NotReadableError: Could not start audio source", attempt: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("поздний подъём, а владелец за это время выключил микрофон → activate НЕ зовётся", async () => {
    const activate = vi.fn();
    let muted = false;
    const boot = createMicBoot({
      startCapture: vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue(undefined),
      isMuted: () => muted,
      bridge: { activate },
      ui: { up: vi.fn(), down: vi.fn() },
    });
    await boot.ensure();
    muted = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(boot.isUp).toBe(true);
    expect(activate).not.toHaveBeenCalled();
  });
});

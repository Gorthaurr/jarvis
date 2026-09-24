/**
 * Ревью 2026-09-24 (H-L2): сторож главного окна — падение renderer больше не делает Джарвиса молча
 * глухим/немым. Проводка проверяется на подделках Electron (как selection/wiring.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAUNCH_FLAG, RendererCrashPolicy, UNRESPONSIVE_GRACE_MS, relaunchArgs, relaunchCount, wireRendererGuard } from "./renderer-guard.js";

function rig(argv: string[] = ["."]) {
  let clock = 0;
  const h: { gone?: (r: string) => void; unresp?: () => void; resp?: () => void } = {};
  const d = {
    onGone: (cb: (r: string) => void) => (h.gone = cb),
    onUnresponsive: (cb: () => void) => (h.unresp = cb),
    onResponsive: (cb: () => void) => (h.resp = cb),
    reload: vi.fn(),
    crashRenderer: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
    isQuitting: vi.fn(() => false),
    onRendererLost: vi.fn(),
    argv,
    log: { warn: vi.fn(), error: vi.fn() },
    now: () => clock,
  };
  wireRendererGuard(d);
  const at = (ms: number): void => {
    clock = ms;
  };
  return { d, h, at };
}

describe("RendererCrashPolicy", () => {
  it("бэкофф 1 с → 2 с, третье падение за 5 мин — перезапуск процесса; старые падения из окна уходят", () => {
    const p = new RendererCrashPolicy();
    expect(p.note(0)).toEqual({ action: "reload", delayMs: 1000, recent: 1 });
    expect(p.note(60_000)).toEqual({ action: "reload", delayMs: 2000, recent: 2 });
    expect(p.note(120_000)).toMatchObject({ action: "relaunch", recent: 3 });
    const q = new RendererCrashPolicy();
    q.note(0);
    q.note(1_000);
    expect(q.note(400_000)).toMatchObject({ action: "reload", recent: 1 }); // первые два старше 5 мин
  });

  it("после двух самоперезапусков — только exit(1): цикл без пауз не крутим, дальше решает хранитель", () => {
    const p = new RendererCrashPolicy(2);
    p.note(0);
    p.note(1);
    expect(p.note(2).action).toBe("exit");
  });

  it("счётчик перезапусков едет в argv и заменяется, а не копится", () => {
    const a = relaunchArgs([".", `${RELAUNCH_FLAG}=1`], 2);
    expect(a).toEqual([".", `${RELAUNCH_FLAG}=2`]);
    expect(relaunchCount(a)).toBe(2);
    expect(relaunchCount(["."])).toBe(0);
  });
});

describe("wireRendererGuard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("render-process-gone → лог, «звук не играет», reload через 1 с", () => {
    const { d, h } = rig();
    h.gone!("crashed");
    expect(d.onRendererLost).toHaveBeenCalledTimes(1);
    expect(d.log.warn).toHaveBeenCalled();
    expect(d.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it("серия из трёх падений → app.relaunch(со счётчиком) + exit(1)", () => {
    const { d, h, at } = rig(["."]);
    h.gone!("crashed");
    at(10_000);
    h.gone!("oom");
    at(20_000);
    h.gone!("crashed");
    expect(d.relaunch).toHaveBeenCalledWith([".", `${RELAUNCH_FLAG}=1`]);
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it("штатный выход и clean-exit — не авария: ни reload, ни exit", () => {
    const { d, h } = rig();
    h.gone!("clean-exit");
    d.isQuitting.mockReturnValue(true);
    h.gone!("crashed");
    vi.advanceTimersByTime(60_000);
    expect(d.reload).not.toHaveBeenCalled();
    expect(d.exit).not.toHaveBeenCalled();
    expect(d.onRendererLost).not.toHaveBeenCalled();
  });

  it("зависание дольше порога → принудительное падение (дальше — путь reload); ожил раньше — ничего", () => {
    const a = rig();
    a.h.unresp!();
    vi.advanceTimersByTime(UNRESPONSIVE_GRACE_MS - 1);
    a.h.resp!();
    vi.advanceTimersByTime(60_000);
    expect(a.d.crashRenderer).not.toHaveBeenCalled();
    const b = rig();
    b.h.unresp!();
    vi.advanceTimersByTime(UNRESPONSIVE_GRACE_MS);
    expect(b.d.crashRenderer).toHaveBeenCalledTimes(1);
  });
});

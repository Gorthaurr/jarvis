/**
 * §Волна3 (3.4) — тесты предикат-наблюдений: проверка идёт КЛИЕНТСКИМ каналом (не LLM-чекером),
 * met → уведомление; нет живой сессии → честная ошибка (не met); LLM-чекер для обычных не тронут.
 */
import { describe, expect, it, vi } from "vitest";
import { WatchStore } from "./store.js";
import { WatchService } from "./service.js";

const mkStore = (): WatchStore => {
  const store = new WatchStore(`${process.env.JARVIS_DATA_DIR ?? "data"}/watch-pred-test-${Math.random().toString(36).slice(2)}.json`);
  return store;
};

describe("watch с локальным предикатом (§Волна3 3.4)", () => {
  it("предикат-наблюдение проверяется через канал действий; met → озвучка", async () => {
    const llmChecker = vi.fn();
    const svc = new WatchService(llmChecker as never, mkStore(), { now: () => Date.now() });
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u1", (t) => spoken.push(t));
    const send = vi.fn().mockResolvedValue({ ok: true, data: { met: true, detail: "окно найдено" } });
    svc.registerActions("s1", "u1", send);

    const res = svc.add({
      sessionId: "s1",
      userId: "u1",
      what: "поиск матча в доте",
      condition: "матч найден — на экране кнопка Принять",
      intervalMs: 5_000,
      predicate: { kind: "text", text: "ПРИНЯТЬ" },
    });
    expect(res.ok).toBe(true);

    await svc.tickNow();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ kind: "wait.for", condition: { kind: "text", text: "ПРИНЯТЬ" } });
    expect(llmChecker).not.toHaveBeenCalled(); // предикат НЕ ходит в LLM-чекер
    expect(spoken.join(" ")).toContain("Сработало");
    svc.stop();
  });

  it("нет живой сессии → честная ошибка (не met), наблюдение живо до следующего тика", async () => {
    const svc = new WatchService(vi.fn() as never, mkStore(), { now: () => Date.now() });
    const res = svc.add({
      sessionId: "dead",
      userId: "u1",
      what: "x",
      condition: "y",
      intervalMs: 5_000,
      predicate: { kind: "window", titleContains: "Dota" },
    });
    expect(res.ok).toBe(true);
    await svc.tickNow();
    const w = svc.list({ userId: "u1" })[0]!;
    expect(w.status).toBe("active"); // не сработало и не умерло — повторим в следующий тик
    svc.stop();
  });

  it("предикатный интервал жмётся мягче (5с против 30с LLM-чекера)", () => {
    const svc = new WatchService(vi.fn() as never, mkStore(), { now: () => Date.now() });
    const a = svc.add({ sessionId: "s", userId: "u", what: "a", condition: "b", intervalMs: 1_000, predicate: { kind: "sound", playing: true } });
    const b = svc.add({ sessionId: "s", userId: "u", what: "c", condition: "d", intervalMs: 1_000 });
    expect(a.ok && a.watch.intervalMs).toBe(5_000);
    expect(b.ok && b.watch.intervalMs).toBe(30_000);
    svc.stop();
  });
});

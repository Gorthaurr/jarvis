import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WatchService } from "./service.js";
import { WatchStore } from "./store.js";
import type { CheckResult, Watch } from "./watch.js";

let dirCounter = 0;
function tempDir(): string {
  return join(tmpdir(), `jarvis-watch-${process.pid}-${dirCounter++}`);
}

describe("WatchService — durable повторяющееся наблюдение + проактивное уведомление", () => {
  it("one-shot: met → уведомляет ОДИН раз и перестаёт следить", async () => {
    let clock = 1_000_000;
    const speak = vi.fn();
    let met = false;
    const checker = vi.fn(async (_w: Watch): Promise<CheckResult> => ({ met, value: "X", summary: "Биткоин ниже 60000." }));
    const svc = new WatchService(checker, new WatchStore(tempDir()), { now: () => clock, minIntervalMs: 1000 });
    svc.registerSpeaker("s1", "u1", speak);
    const r = svc.add({ sessionId: "s1", userId: "u1", what: "курс биткоина", condition: "ниже 60000", intervalMs: 1000 });
    expect(r.ok).toBe(true);

    await svc.tickNow(); // условие не выполнено
    expect(checker).toHaveBeenCalledTimes(1);
    expect(speak).not.toHaveBeenCalled();

    clock += 1000;
    met = true;
    await svc.tickNow(); // выполнено → уведомление
    expect(speak).toHaveBeenCalledWith("Биткоин ниже 60000.");

    clock += 1000;
    await svc.tickNow(); // one-shot завершилось → больше не проверяет
    expect(checker).toHaveBeenCalledTimes(2);
    expect(svc.list({ userId: "u1" })).toHaveLength(0);
  });

  it("continuous: уведомляет при met, НЕ дублирует тот же summary, снова уведомляет после отлипания", async () => {
    let clock = 0;
    const speak = vi.fn();
    let result: CheckResult = { met: false, summary: "" };
    const svc = new WatchService(async () => result, new WatchStore(tempDir()), { now: () => clock, minIntervalMs: 100 });
    svc.registerSpeaker("s1", "u1", speak);
    svc.add({ sessionId: "s1", userId: "u1", what: "статус сборки", condition: "появилось 'успех'", intervalMs: 100, continuous: true });

    result = { met: true, summary: "Сборка прошла успешно." };
    await svc.tickNow();
    expect(speak).toHaveBeenCalledTimes(1);

    clock += 100; // тот же summary — антидребезг, не дублируем
    await svc.tickNow();
    expect(speak).toHaveBeenCalledTimes(1);

    clock += 100; // условие отлипло → сбрасываем антидребезг
    result = { met: false, summary: "" };
    await svc.tickNow();
    expect(speak).toHaveBeenCalledTimes(1);

    clock += 100; // снова met тем же summary → снова уведомляем
    result = { met: true, summary: "Сборка прошла успешно." };
    await svc.tickNow();
    expect(speak).toHaveBeenCalledTimes(2);
    expect(svc.list({ userId: "u1" })).toHaveLength(1); // continuous остаётся активным
  });

  it("ошибка проверки (сеть) → НЕ уведомляет, наблюдение остаётся активным (повтор в след. тик)", async () => {
    let clock = 0;
    const speak = vi.fn();
    let result: CheckResult = { met: false, summary: "", error: "fetch failed" };
    const svc = new WatchService(async () => result, new WatchStore(tempDir()), { now: () => clock, minIntervalMs: 100 });
    svc.registerSpeaker("s1", "u1", speak);
    svc.add({ sessionId: "s1", userId: "u1", what: "сайт", condition: "доступен", intervalMs: 100, continuous: true });
    await svc.tickNow();
    expect(speak).not.toHaveBeenCalled();
    expect(svc.list({ userId: "u1" })).toHaveLength(1);
    clock += 100;
    result = { met: true, summary: "Сайт снова доступен." };
    await svc.tickNow();
    expect(speak).toHaveBeenCalledWith("Сайт снова доступен.");
  });

  it("сработало БЕЗ активной сессии → отложено и доставлено при подключении (по userId, не sessionId)", async () => {
    let clock = 0;
    const svc = new WatchService(async () => ({ met: true, summary: "Готово!" }), new WatchStore(tempDir()), {
      now: () => clock,
      minIntervalMs: 100,
    });
    svc.add({ sessionId: "s1", userId: "u1", what: "x", condition: "y", intervalMs: 100 });
    await svc.tickNow(); // met, но speaker нет
    const speak = vi.fn();
    svc.registerSpeaker("s2", "u1", speak); // подключились новой сессией
    expect(speak).toHaveBeenCalledWith("Готово!");
  });

  it("НЕ доставляет уведомление ЧУЖОМУ пользователю (изоляция §6B/B3)", async () => {
    let clock = 0;
    const svc = new WatchService(async () => ({ met: true, summary: "секрет" }), new WatchStore(tempDir()), {
      now: () => clock,
      minIntervalMs: 100,
    });
    const other = vi.fn();
    svc.registerSpeaker("sOther", "uOther", other); // чужая сессия
    svc.add({ sessionId: "s1", userId: "u1", what: "x", condition: "y", intervalMs: 100 });
    await svc.tickNow();
    expect(other).not.toHaveBeenCalled(); // чужому не утекло
  });

  it("add: клампит интервал к минимуму, отвергает сверх лимита и пустые поля", () => {
    const svc = new WatchService(async () => ({ met: false, summary: "" }), new WatchStore(tempDir()), {
      minIntervalMs: 5000,
      maxPerUser: 2,
    });
    const r1 = svc.add({ sessionId: "s", userId: "u", what: "a", condition: "c", intervalMs: 100 });
    expect(r1.ok ? r1.watch.intervalMs : -1).toBe(5000); // клампнут к минимуму
    svc.add({ sessionId: "s", userId: "u", what: "b", condition: "c", intervalMs: 10000 });
    const r3 = svc.add({ sessionId: "s", userId: "u", what: "d", condition: "c", intervalMs: 10000 });
    expect(r3.ok).toBe(false); // лимит 2 на пользователя
    const r4 = svc.add({ sessionId: "s", userId: "u2", what: "  ", condition: "c", intervalMs: 10000 });
    expect(r4.ok).toBe(false); // пустое what
  });

  it("cancel по id и по тексту-запросу; durable — активные переживают перезагрузку с диска", async () => {
    const dir = tempDir();
    const store = new WatchStore(dir);
    const svc = new WatchService(async () => ({ met: false, summary: "" }), store, { minIntervalMs: 100 });
    svc.add({ sessionId: "s", userId: "u", what: "курс биткоина", condition: "ниже 60000", intervalMs: 100 });
    const b = svc.add({ sessionId: "s", userId: "u", what: "погода в Москве", condition: "дождь", intervalMs: 100 });
    expect(svc.list({ userId: "u" })).toHaveLength(2);

    expect(svc.cancel("биткоин", "u")?.what).toContain("биткоина"); // по тексту what
    expect(b.ok ? svc.cancel(b.watch.id)?.id : undefined).toBe(b.ok ? b.watch.id : "x"); // по id
    expect(svc.list({ userId: "u" })).toHaveLength(0);

    // одно активное → durable: новый стор на том же каталоге видит его (а снятые — нет).
    svc.add({ sessionId: "s", userId: "u", what: "сборка CI", condition: "зелёная", intervalMs: 100 });
    await store.flush();
    const store2 = new WatchStore(dir);
    await store2.load();
    const active = store2.list({ userId: "u" });
    expect(active).toHaveLength(1);
    expect(active[0]?.what).toContain("CI");
  });
});

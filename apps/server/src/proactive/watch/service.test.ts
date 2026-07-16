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

  it("M12: cancel by-id уважает ownership — чужой userId НЕ снимает наблюдение по эхнутому id", async () => {
    const svc = new WatchService(async () => ({ met: false, summary: "" }), new WatchStore(tempDir()), { minIntervalMs: 100 });
    const mine = svc.add({ sessionId: "s", userId: "owner", what: "секрет-наблюдение", condition: "c", intervalMs: 100 });
    const id = mine.ok ? mine.watch.id : "x";
    // Чужой пользователь знает id (эхо) — снять НЕ может.
    expect(svc.cancel(id, "attacker")).toBeNull();
    expect(svc.list({ userId: "owner" })).toHaveLength(1); // цело
    // Владелец — снимает.
    expect(svc.cancel(id, "owner")?.id).toBe(id);
    expect(svc.list({ userId: "owner" })).toHaveLength(0);
  });

  it("M13: svc.flush() дренирует стор → активное наблюдение видно свежему стору (gateway.close путь)", async () => {
    const dir = tempDir();
    const svc = new WatchService(async () => ({ met: false, summary: "" }), new WatchStore(dir), { minIntervalMs: 100 });
    svc.add({ sessionId: "s", userId: "u", what: "сборка CI", condition: "зелёная", intervalMs: 100 });
    await svc.flush(); // M13: дренируем через сервис (не store.flush()) — как в gateway.close()
    const store2 = new WatchStore(dir);
    await store2.load();
    expect(store2.list({ userId: "u" })).toHaveLength(1);
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

  it("dead-watch (D3, форензика 2026-07-14): серия провалов проверки → suspended + ОДНО уведомление, больше не тикает", async () => {
    let clock = 0;
    const speak = vi.fn();
    // Чекер ВСЕГДА возвращает ошибку — как битый watch из эпизода (142 провала подряд в тишине).
    const checker = vi.fn(async (): Promise<CheckResult> => ({ met: false, summary: "", error: "нет result за 8000ms" }));
    const svc = new WatchService(checker, new WatchStore(tempDir()), { now: () => clock, minIntervalMs: 100, maxFailures: 3 });
    svc.registerSpeaker("s", "u", speak);
    svc.add({ sessionId: "s", userId: "u", what: "время видео", condition: "дошло до 35", intervalMs: 100, continuous: true });
    for (let i = 0; i < 5; i += 1) {
      await svc.tickNow();
      clock += 100;
    }
    // На 3-м провале — suspended + ОДНО уведомление; дальнейшие тики его не трогают (не тикает, не спамит).
    expect(checker).toHaveBeenCalledTimes(3); // после suspend больше не проверяется
    expect(speak).toHaveBeenCalledTimes(1);
    expect(String(speak.mock.calls[0]?.[0])).toContain("приостановил");
    expect(svc.list({ userId: "u" })).toHaveLength(0); // suspended не в active-списке
  });

  it("dead-watch (ревью р2 #6): ТРАНЗИЕНТНЫЙ провал (нет живой сессии) НЕ копится к suspend", async () => {
    // «скажи когда матч найдётся» + свёрнутое окно на минуту → 10+ «нет живой сессии» подряд НЕ должны
    // навсегда suspend'ить watch (клиент вернётся). Только transient=true — прочие ошибки копятся.
    let clock = 0;
    const checker = vi.fn(async (): Promise<CheckResult> => ({ met: false, summary: "", error: "нет живой сессии", transient: true }));
    const svc = new WatchService(checker, new WatchStore(tempDir()), { now: () => clock, minIntervalMs: 100, maxFailures: 3 });
    svc.registerSpeaker("s", "u", vi.fn());
    svc.add({ sessionId: "s", userId: "u", what: "матч", condition: "найдётся", intervalMs: 100, continuous: true });
    for (let i = 0; i < 8; i += 1) {
      await svc.tickNow();
      clock += 100;
    }
    expect(svc.list({ userId: "u" })).toHaveLength(1); // всё ещё active — транзиент не suspend'ит
  });

  it("dead-watch: успешная проверка СБРАСЫВАЕТ счётчик провалов (эпизодический сбой не копится к suspend)", async () => {
    let clock = 0;
    let fail = true;
    const svc = new WatchService(
      async (): Promise<CheckResult> => (fail ? { met: false, summary: "", error: "сеть" } : { met: false, summary: "" }),
      new WatchStore(tempDir()),
      { now: () => clock, minIntervalMs: 100, maxFailures: 3 },
    );
    svc.registerSpeaker("s", "u", vi.fn());
    svc.add({ sessionId: "s", userId: "u", what: "курс", condition: "ниже X", intervalMs: 100, continuous: true });
    await svc.tickNow(); clock += 100; // fail 1
    await svc.tickNow(); clock += 100; // fail 2
    fail = false;
    await svc.tickNow(); clock += 100; // успех → счётчик сброшен
    fail = true;
    await svc.tickNow(); clock += 100; // fail 1 снова
    await svc.tickNow(); clock += 100; // fail 2 — до порога 3 не дошли
    expect(svc.list({ userId: "u" })).toHaveLength(1); // всё ещё active (не suspended)
  });

  it("(fix 2026-07-15) browser-предикат: проверяется через browserProbe (не клиентский wait.for), met → уведомляет", async () => {
    let clock = 1_000_000;
    const speak = vi.fn();
    let reached = false;
    const probe = vi.fn(async () => ({ met: reached, detail: `currentTime=${reached ? 1600 : 1400}` }));
    // checker НЕ должен вызываться для предикат-наблюдения (это проверка на сервере, не LLM).
    const checker = vi.fn(async (): Promise<CheckResult> => ({ met: false, summary: "" }));
    const svc = new WatchService(checker, new WatchStore(tempDir()), { now: () => clock, minIntervalMs: 1000 });
    svc.setBrowserProbe(probe);
    svc.registerSpeaker("s1", "u1", speak);
    svc.add({
      sessionId: "s1",
      userId: "u1",
      what: "видео дошло до 26-й минуты",
      condition: "видео на 26:00",
      intervalMs: 5000,
      predicate: { kind: "browser", prop: "currentTime", op: ">=", value: 1560 },
    });

    await svc.tickNow(); // ещё не дошло
    expect(probe).toHaveBeenCalledTimes(1);
    expect(checker).not.toHaveBeenCalled(); // предикат → browserProbe, НЕ LLM-чекер
    expect(speak).not.toHaveBeenCalled();

    clock += 5000;
    reached = true;
    await svc.tickNow(); // дошло → уведомление
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("(fix 2026-07-15) browser-предикат без browserProbe / расширение отключено → транзиент, НЕ dead-watch", async () => {
    let clock = 0;
    const svc = new WatchService(
      async (): Promise<CheckResult> => ({ met: false, summary: "" }),
      new WatchStore(tempDir()),
      { now: () => clock, minIntervalMs: 100, maxFailures: 2 },
    );
    // browserProbe НЕ задан → транзиентная недоступность (как «нет живой сессии»): не копится к suspend.
    // ⚠️ Предикат-watch: минимальный интервал = minPredicateIntervalMs(5000), intervalMs бампится до него,
    // поэтому clock двигаем на 5000/тик (иначе наблюдение не «созревает» повторно).
    svc.registerSpeaker("s", "u", vi.fn());
    svc.add({ sessionId: "s", userId: "u", what: "видео", condition: "26:00", intervalMs: 5000, continuous: true, predicate: { kind: "browser", value: 1560 } });
    await svc.tickNow(); clock += 5000;
    await svc.tickNow(); clock += 5000;
    await svc.tickNow(); clock += 5000; // 3 «провала», но транзиентные → maxFailures(2) не срабатывает
    expect(svc.list({ userId: "u" }).filter((w) => w.status === "active")).toHaveLength(1);
  });

  it("(fix 2026-07-15) browserProbe вернул error transient:true → НЕ dead-watch; transient:false → суспенд после maxFailures", async () => {
    let clock = 0;
    let transient = true;
    const probe = vi.fn(async () => ({ met: false, detail: "", error: "нет вкладки", transient }));
    const svc = new WatchService(
      async (): Promise<CheckResult> => ({ met: false, summary: "" }),
      new WatchStore(tempDir()),
      { now: () => clock, minIntervalMs: 100, maxFailures: 2 },
    );
    svc.setBrowserProbe(probe);
    svc.registerSpeaker("s", "u", vi.fn());
    // Предикат-watch: интервал бампится до minPredicateIntervalMs(5000) → clock двигаем на 5000/тик.
    svc.add({ sessionId: "s", userId: "u", what: "видео", condition: "26:00", intervalMs: 5000, continuous: true, predicate: { kind: "browser", value: 1560 } });
    await svc.tickNow(); clock += 5000;
    await svc.tickNow(); clock += 5000;
    await svc.tickNow(); clock += 5000;
    expect(svc.list({ userId: "u" }).filter((w) => w.status === "active")).toHaveLength(1); // транзиент не копится

    transient = false; // теперь ошибки НЕ транзиентные → должны копиться к suspend
    await svc.tickNow(); clock += 5000; // fail 1
    await svc.tickNow(); clock += 5000; // fail 2 → maxFailures(2) → suspended
    expect(svc.list({ userId: "u" }).filter((w) => w.status === "active")).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReminderStore } from "./store.js";
import { ReminderService } from "./service.js";

let counter = 0;
const makeStore = (): ReminderStore =>
  new ReminderStore(join(tmpdir(), `jarvis-rem-svc-${process.pid}-${Date.now()}-${counter++}`));

describe("ReminderService — durable-таймер + проактивная доставка (§9)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("срабатывает по времени и озвучивает через сессию", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u", (t) => spoken.push(t));
    svc.add({ sessionId: "s1", userId: "u", text: "Пора в зал", fireAt: clock + 5000 });
    expect(spoken).toEqual([]);
    clock += 5000;
    vi.advanceTimersByTime(5000);
    expect(spoken).toEqual(["Пора в зал"]);
  });

  it("нет активной сессии → держит и доставляет при подключении (flushPending)", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    svc.add({ sessionId: "s1", userId: "u", text: "Выпей воды", fireAt: clock + 1000 });
    clock += 1000;
    vi.advanceTimersByTime(1000); // сработало в тишину (озвучки нет)
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u", (t) => spoken.push(t)); // подключились позже
    expect(spoken).toEqual(["Выпей воды"]);
  });

  it("несколько напоминаний — каждое в свой момент, в правильном порядке", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u", (t) => spoken.push(t));
    svc.add({ sessionId: "s1", userId: "u", text: "второе", fireAt: clock + 2000 });
    svc.add({ sessionId: "s1", userId: "u", text: "первое", fireAt: clock + 1000 });
    clock += 1000;
    vi.advanceTimersByTime(1000);
    expect(spoken).toEqual(["первое"]);
    clock += 1000;
    vi.advanceTimersByTime(1000);
    expect(spoken).toEqual(["первое", "второе"]);
  });

  it("отмена по id и по тексту снимает напоминание", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u", (t) => spoken.push(t));
    const r = svc.add({ sessionId: "s1", userId: "u", text: "по id", fireAt: clock + 2000 });
    svc.add({ sessionId: "s1", userId: "u", text: "позвонить маме", fireAt: clock + 3000 });
    expect(svc.cancel(r.id)?.id).toBe(r.id);
    expect(svc.cancel("маме")?.text).toBe("позвонить маме");
    expect(svc.list("s1")).toEqual([]);
    clock += 3000;
    vi.advanceTimersByTime(3000);
    expect(spoken).toEqual([]);
  });

  it("M13: svc.flush() дренирует стор → запланированное напоминание видно свежему стору (gateway.close путь)", async () => {
    let clock = 1_000_000;
    const dir = join(tmpdir(), `jarvis-rem-flush-${process.pid}-${Date.now()}-${counter++}`);
    const svc = new ReminderService(new ReminderStore(dir), { now: () => clock });
    await svc.start();
    svc.add({ sessionId: "s1", userId: "u", text: "не потеряться", fireAt: clock + 60_000 });
    await svc.flush(); // M13: дренируем через сервис (не store.flush()) — как в gateway.close()
    const store2 = new ReminderStore(dir);
    await store2.load();
    expect(store2.list({ userId: "u" })).toHaveLength(1);
  });

  it("L2: cancel by-id уважает ownership — чужая сессия НЕ снимает напоминание по эхнутому id", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const mine = svc.add({ sessionId: "sOwner", userId: "u", text: "личное", fireAt: clock + 5000 });
    // Чужая сессия знает id (эхо) — снять НЕ может (by-id теперь фильтруется по sessionId).
    expect(svc.cancel(mine.id, "sAttacker")).toBeNull();
    expect(svc.list("sOwner")).toHaveLength(1); // цело
    // Своя сессия — снимает.
    expect(svc.cancel(mine.id, "sOwner")?.id).toBe(mine.id);
    expect(svc.list("sOwner")).toHaveLength(0);
  });

  it("catch-up: просроченное сверх grace при старте — пропускается", async () => {
    const clock = 100_000_000;
    const store = makeStore();
    store.add({
      id: "old",
      sessionId: "s1",
      userId: "u",
      text: "стухло",
      status: "scheduled",
      createdAt: 0,
      fireAt: clock - 10 * 3600_000, // 10 ч назад, grace 6 ч
    });
    await store.flush();
    const svc = new ReminderService(store, { now: () => clock, graceMs: 6 * 3600_000 });
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u", (t) => spoken.push(t));
    await svc.start();
    vi.advanceTimersByTime(100);
    expect(spoken).toEqual([]); // не озвучиваем стухшее
    expect(svc.list("s1")).toEqual([]); // и не висит активным
  });

  it("просроченное В пределах grace при старте — озвучивается сразу", async () => {
    const clock = 100_000_000;
    const store = makeStore();
    store.add({
      id: "recent",
      sessionId: "s1",
      userId: "u",
      text: "догнать",
      status: "scheduled",
      createdAt: 0,
      fireAt: clock - 60_000, // минуту назад, в пределах grace
    });
    await store.flush();
    const svc = new ReminderService(store, { now: () => clock, graceMs: 6 * 3600_000 });
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u", (t) => spoken.push(t));
    await svc.start();
    vi.advanceTimersByTime(0); // reschedule поставил delay=0 на просроченное → fires
    expect(spoken).toEqual(["догнать"]);
  });

  it("§6B/B3: отложенное напоминание НЕ утекает ДРУГОМУ пользователю (flushPending по userId)", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    svc.add({ sessionId: "sA", userId: "uA", text: "личное для A", fireAt: clock + 1000 });
    clock += 1000;
    vi.advanceTimersByTime(1000); // сработало в тишину (никого нет)
    // Подключился ЧУЖОЙ пользователь — не должен услышать напоминание A
    const heardByB: string[] = [];
    svc.registerSpeaker("sB", "uB", (t) => heardByB.push(t));
    expect(heardByB).toEqual([]);
    // Подключился A (новый sessionId, тот же userId) — получает своё
    const heardByA: string[] = [];
    svc.registerSpeaker("sA2", "uA", (t) => heardByA.push(t));
    expect(heardByA).toEqual(["личное для A"]);
  });

  it("идемпотентность: идентичный текст+fireAt в окне → ОДНО напоминание (не задвоение)", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const r1 = svc.add({ sessionId: "s1", userId: "u", text: "конец теста", fireAt: clock + 40_000 });
    const r2 = svc.add({ sessionId: "s1", userId: "u", text: "конец теста", fireAt: clock + 42_000 }); // +2с, в окне
    expect(r2.id).toBe(r1.id); // вернулся существующий, не создан новый
    expect(svc.list("s1")).toHaveLength(1);
  });

  it("идемпотентность НЕ режет разные напоминания (другой текст / далёкий fireAt)", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    svc.add({ sessionId: "s1", userId: "u", text: "позвонить маме", fireAt: clock + 40_000 });
    svc.add({ sessionId: "s1", userId: "u", text: "выпить воды", fireAt: clock + 40_000 }); // другой текст
    svc.add({ sessionId: "s1", userId: "u", text: "позвонить маме", fireAt: clock + 600_000 }); // далеко по времени
    expect(svc.list("s1")).toHaveLength(3);
  });

  it("§6B/B3: live-доставка идёт ВЛАДЕЛЬЦУ (по userId, даже с новым sessionId), не чужому", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const heardByA: string[] = [];
    const heardByB: string[] = [];
    svc.registerSpeaker("sB", "uB", (t) => heardByB.push(t)); // чужой активен
    svc.registerSpeaker("sA2", "uA", (t) => heardByA.push(t)); // A переподключился (sA2 ≠ исходный sA)
    svc.add({ sessionId: "sA", userId: "uA", text: "для A", fireAt: clock + 1000 });
    clock += 1000;
    vi.advanceTimersByTime(1000);
    expect(heardByA).toEqual(["для A"]); // доставлено владельцу по userId (исходная sA не активна)
    expect(heardByB).toEqual([]); // чужому — НЕТ (фикс any-speaker fallback)
  });
});

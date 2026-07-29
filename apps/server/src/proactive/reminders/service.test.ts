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
    expect(svc.list("u")).toEqual([]);
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

  it("L2: cancel by-id уважает ownership — чужой пользователь НЕ снимает напоминание по эхнутому id", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const mine = svc.add({ sessionId: "sOwner", userId: "u", text: "личное", fireAt: clock + 5000 });
    // Чужой ПОЛЬЗОВАТЕЛЬ знает id (эхо) — снять НЕ может (by-id фильтруется по владельцу).
    expect(svc.cancel(mine.id, "uAttacker")).toBeNull();
    expect(svc.list("u")).toHaveLength(1); // цело
    // Владелец — снимает.
    expect(svc.cancel(mine.id, "u")?.id).toBe(mine.id);
    expect(svc.list("u")).toHaveLength(0);
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
    expect(svc.list("u")).toEqual([]); // и не висит активным
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
    expect(svc.list("u")).toHaveLength(1);
  });

  it("идемпотентность НЕ режет разные напоминания (другой текст / далёкий fireAt)", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    svc.add({ sessionId: "s1", userId: "u", text: "позвонить маме", fireAt: clock + 40_000 });
    svc.add({ sessionId: "s1", userId: "u", text: "выпить воды", fireAt: clock + 40_000 }); // другой текст
    svc.add({ sessionId: "s1", userId: "u", text: "позвонить маме", fireAt: clock + 600_000 }); // далеко по времени
    expect(svc.list("u")).toHaveLength(3);
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

  // ── ВОЛНА D: повторяющиеся напоминания ────────────────────────────────────────────────────────
  it("повтор: после срабатывания серия ЖИВЁТ — звучит и на следующий раз", async () => {
    let clock = new Date("2026-07-29T08:59:59").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u", (t) => spoken.push(t));
    svc.add({ sessionId: "s1", userId: "u", text: "Пить таблетки", fireAt: clock + 1000, repeat: { kind: "daily" } });

    clock += 1000;
    vi.advanceTimersByTime(1000);
    expect(spoken).toEqual(["Пить таблетки"]); // первое срабатывание
    expect(svc.list("u")).toHaveLength(1); // следующее уже запланировано (серия не умерла)

    clock += 24 * 3600_000;
    vi.advanceTimersByTime(24 * 3600_000);
    expect(spoken).toEqual(["Пить таблетки", "Пить таблетки"]); // и на следующий день
  });

  it("одноразовое остаётся одноразовым (регресс: серия не появляется сама)", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u", (t) => spoken.push(t));
    svc.add({ sessionId: "s1", userId: "u", text: "Разовое", fireAt: clock + 1000 });
    clock += 1000;
    vi.advanceTimersByTime(1000);
    expect(spoken).toEqual(["Разовое"]);
    expect(svc.list("u")).toHaveLength(0); // ничего не перепланировано
  });

  it("отмена прекращает СЕРИЮ (следующего срабатывания не будет)", async () => {
    let clock = new Date("2026-07-29T08:59:59").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u", (t) => spoken.push(t));
    svc.add({ sessionId: "s1", userId: "u", text: "Зарядка", fireAt: clock + 1000, repeat: { kind: "daily" } });
    clock += 1000;
    vi.advanceTimersByTime(1000);
    expect(spoken).toHaveLength(1);
    expect(svc.cancel("зарядка", "u")).not.toBeNull(); // владелец: «отмени зарядку»
    clock += 2 * 24 * 3600_000;
    vi.advanceTimersByTime(2 * 24 * 3600_000);
    expect(spoken).toHaveLength(1); // больше не звучит
  });

  // РЕВЬЮ ВОЛНЫ D (HIGH): дедуп серий сверял только текст+ритм и молча съедал ВТОРОЙ слот —
  // «пить таблетки каждый день в 9 утра И в 9 вечера» превращалось в одно утреннее напоминание,
  // а хендлер рапортовал успех (masked failure).
  it("две ежедневные серии с одним текстом, но РАЗНЫМ временем — обе живут", async () => {
    const clock = new Date("2026-07-29T07:00:00").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const morning = svc.add({
      sessionId: "s1", userId: "u", text: "Пора пить таблетки, сэр",
      fireAt: new Date("2026-07-29T09:00:00").getTime(), repeat: { kind: "daily" },
    });
    const evening = svc.add({
      sessionId: "s1", userId: "u", text: "Пора пить таблетки, сэр",
      fireAt: new Date("2026-07-29T21:00:00").getTime(), repeat: { kind: "daily" },
    });
    expect(evening.id).not.toBe(morning.id); // вечерняя серия НЕ съедена
    expect(svc.list("u")).toHaveLength(2);
  });

  it("та же серия, пере-сказанная владельцем (то же время суток) — второй копии НЕ создаём", async () => {
    const clock = new Date("2026-07-29T07:00:00").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const a = svc.add({
      sessionId: "s1", userId: "u", text: "Пора пить таблетки, сэр",
      fireAt: new Date("2026-07-29T09:00:00").getTime(), repeat: { kind: "daily" },
    });
    const b = svc.add({
      sessionId: "s1", userId: "u", text: "Пора пить таблетки, сэр",
      fireAt: new Date("2026-07-30T09:00:00").getTime(), repeat: { kind: "daily" }, // завтра, тот же слот
    });
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false); // и вызывающий видит, что НЕ создано (рефлекс не соврёт «поставил»)
    expect(svc.list("u")).toHaveLength(1);
  });

  // КОНТРОЛЬ ВОЛНЫ D (HIGH): дедуп-гейты ВЫШЕ серийного (точная идемпотентность и subject-окно)
  // ритм не сверяли — «а теперь напоминай это КАЖДЫЙ ДЕНЬ» схлопывалось в уже стоящее ОДНОРАЗОВОЕ,
  // хендлер рапортовал успех, серия молча не существовала.
  it("одноразовое → та же просьба С ПОВТОРОМ: серия создаётся, а не съедается дедупом", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const once = svc.add({ sessionId: "s1", userId: "u", text: "Пора пить таблетки", fireAt: clock + 3600_000 });
    expect(once.created).toBe(true);
    const series = svc.add({
      sessionId: "s1", userId: "u", text: "Пора пить таблетки",
      fireAt: clock + 3600_000, repeat: { kind: "daily" },
    });
    expect(series.id).not.toBe(once.id);
    expect(series.repeat).toEqual({ kind: "daily" });
  });

  // КОНТРОЛЬ-2 (HIGH, регрессия предыдущего фикса): гард ритма перестал съедать серию, но обе записи
  // доживали до общего слота — владелец слышал одно и то же ДВАЖДЫ подряд.
  it("серия ПОГЛОЩАЕТ разовое того же дела на том же слоте — в этот момент звучит ОДИН раз", async () => {
    let clock = new Date("2026-07-29T12:00:00").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u", (t) => spoken.push(t));
    const slot = new Date("2026-07-29T21:00:00").getTime();
    svc.add({ sessionId: "s1", userId: "u", text: "Напоминаю: пить таблетки", fireAt: slot });
    svc.add({ sessionId: "s1", userId: "u", text: "Пора пить таблетки, сэр", fireAt: slot, repeat: { kind: "daily" } });
    expect(svc.list("u")).toHaveLength(1); // разовое поглощено серией
    const delta = slot + 1000 - clock;
    clock = slot + 1000;
    vi.advanceTimersByTime(delta);
    expect(spoken).toHaveLength(1); // в 21:00 звучит ОДИН раз, а не два подряд
  });

  it("зеркальный порядок: серия уже стоит → разовое на тот же слот не плодится", async () => {
    const clock = new Date("2026-07-29T12:00:00").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const slot = new Date("2026-07-29T21:00:00").getTime();
    const series = svc.add({ sessionId: "s1", userId: "u", text: "Пора пить таблетки", fireAt: slot, repeat: { kind: "daily" } });
    const once = svc.add({ sessionId: "s1", userId: "u", text: "Напоминаю: пить таблетки", fireAt: slot });
    expect(once.id).toBe(series.id);
    expect(once.created).toBe(false);
    expect(svc.list("u")).toHaveLength(1);
  });

  // ФИНАЛЬНОЕ РЕВЬЮ (HIGH): поглощение сверяло лишь ВРЕМЯ СУТОК — «по будням в 9:00» съедало субботнее
  // напоминание, которое серия НИКОГДА не обслужит, и хендлер рапортовал успех (ложный успех).
  it("серия «по будням» НЕ съедает субботнее разовое — она в субботу не звонит", async () => {
    const clock = new Date("2026-07-29T08:00:00").getTime(); // среда
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    svc.add({ sessionId: "s1", userId: "u", text: "Сдать отчёт", fireAt: new Date("2026-08-01T09:00:00").getTime() }); // суббота
    svc.add({
      sessionId: "s1", userId: "u", text: "Сдать отчёт",
      fireAt: new Date("2026-08-03T09:00:00").getTime(), repeat: { kind: "weekdays" }, // понедельник
    });
    expect(svc.list("u")).toHaveLength(2); // субботнее живо
  });

  it("зеркально: разовое на субботу СОЗДАЁТСЯ, хотя есть серия «по будням» на то же время", async () => {
    const clock = new Date("2026-07-29T08:00:00").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const series = svc.add({
      sessionId: "s1", userId: "u", text: "Сдать отчёт",
      fireAt: new Date("2026-08-03T09:00:00").getTime(), repeat: { kind: "weekdays" },
    });
    const sat = svc.add({ sessionId: "s1", userId: "u", text: "Сдать отчёт", fireAt: new Date("2026-08-01T09:00:00").getTime() });
    expect(sat.id).not.toBe(series.id);
    expect(sat.created).not.toBe(false);
  });

  it("серия, стартующая ЗАВТРА, не съедает СЕГОДНЯШНЕЕ разовое (прошлое она не обслуживает)", async () => {
    const clock = new Date("2026-07-29T12:00:00").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    svc.add({ sessionId: "s1", userId: "u", text: "Пить таблетки", fireAt: new Date("2026-07-29T21:00:00").getTime() });
    svc.add({
      sessionId: "s1", userId: "u", text: "Пить таблетки",
      fireAt: new Date("2026-07-30T21:00:00").getTime(), repeat: { kind: "daily" },
    });
    expect(svc.list("u")).toHaveLength(2); // сегодняшнее не потеряно
  });

  it("СРАБОТАВШЕЕ, но ещё не доставленное напоминание серия не отменяет (иначе не прозвучит никогда)", async () => {
    let clock = new Date("2026-07-29T20:59:59").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const slot = new Date("2026-07-29T21:00:00").getTime();
    svc.add({ sessionId: "s1", userId: "u", text: "Пить таблетки", fireAt: slot }); // без спикера → сработает «в тишину»
    clock = slot + 1000;
    vi.advanceTimersByTime(1001);
    svc.add({ sessionId: "s1", userId: "u", text: "Пить таблетки", fireAt: slot, repeat: { kind: "daily" } });
    const spoken: string[] = [];
    svc.registerSpeaker("s1", "u", (t) => spoken.push(t)); // владелец подключился
    expect(spoken).toEqual(["Пить таблетки"]); // сработавшее доставлено, а не съедено
  });

  it("разовое на ДРУГОЙ слот серия не трогает (это отдельное дело в другое время)", async () => {
    const clock = new Date("2026-07-29T08:00:00").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    svc.add({ sessionId: "s1", userId: "u", text: "Пить таблетки", fireAt: new Date("2026-07-29T13:00:00").getTime() });
    svc.add({
      sessionId: "s1", userId: "u", text: "Пить таблетки",
      fireAt: new Date("2026-07-29T21:00:00").getTime(), repeat: { kind: "daily" },
    });
    expect(svc.list("u")).toHaveLength(2);
  });

  it("пересказ той же серии на пару минут позже НЕ создаёт вторую серию (допуск слота)", async () => {
    let clock = new Date("2026-07-29T20:00:00").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const a = svc.add({
      sessionId: "s1", userId: "u", text: "Пить таблетки",
      fireAt: new Date("2026-07-29T21:03:00").getTime(), repeat: { kind: "daily" },
    });
    clock = new Date("2026-08-02T20:00:00").getTime();
    const b = svc.add({
      sessionId: "s1", userId: "u", text: "Пить таблетки",
      fireAt: new Date("2026-08-03T21:07:00").getTime(), repeat: { kind: "daily" },
    });
    expect(b.id).toBe(a.id);
    expect(svc.list("u")).toHaveLength(1);
  });

  // КОНТРОЛЬ-5 (MEDIUM): дедуп сравнивал новую просьбу с УЖЕ СРАБОТАВШИМИ недоставленными записями —
  // новое дело молча не создавалось, а подтверждение ссылалось на момент, который уже наступил.
  // КОНТРОЛЬ-8 (HIGH): ЖИВОЙ путь (таймер сработал при подключённом владельце) игнорировал отказ
  // очереди и ставил `done` — напоминание не звучало НИКОГДА, а лог рапортовал «озвучено».
  it("очередь озвучки отказала → напоминание НЕ помечается done, а ждёт доставки", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    svc.registerSpeaker("s1", "u", () => false); // канал есть, но очередь полна
    svc.add({ sessionId: "s1", userId: "u", text: "Пить таблетки", fireAt: clock + 1000 });
    clock += 1001;
    vi.advanceTimersByTime(1001);
    // Сработало, но НЕ помечено доставленным: свободный канал получает его позже.
    const spoken: string[] = [];
    svc.registerSpeaker("s2", "u", (t) => { spoken.push(t); return true; });
    expect(spoken).toEqual(["Пить таблетки"]);
  });

  // КОНТРОЛЬ-10 (HIGH): откат «доставлено» был НО-ОПОМ — markFiredUndelivered ставила только firedAt,
  // а awaitingDelivery смотрит на status==="scheduled", поэтому принятая, но НЕ прозвучавшая реплика
  // («стоп» / смерть сессии) терялась НАВСЕГДА, а лог рапортовал «снова ждёт доставки».
  it("реплику приняли, но она НЕ прозвучала → напоминание снова ждёт доставки (откат реален)", async () => {
    let clock = 1_000_000;
    const store = makeStore();
    const svc = new ReminderService(store, { now: () => clock });
    await svc.start();
    const outcomes: Array<(spoken: boolean) => void> = [];
    svc.registerSpeaker("s1", "u", (_t, cb) => {
      if (cb) outcomes.push(cb);
      return true; // очередь ПРИНЯЛА
    });
    svc.add({ sessionId: "s1", userId: "u", text: "Пить таблетки", fireAt: clock + 1000 });
    clock += 1001;
    vi.advanceTimersByTime(1001);
    expect(outcomes).toHaveLength(1);
    expect(store.awaitingDelivery({ userId: "u" })).toHaveLength(0); // принято → помечено доставленным
    outcomes[0]!(false); // ...но реплику сбросили («стоп» / сессия умерла)
    expect(store.awaitingDelivery({ userId: "u" })).toHaveLength(1); // откат: снова ждёт доставки
  });

  it("прозвучавшее напоминание остаётся доставленным (откат только на false)", async () => {
    let clock = 1_000_000;
    const store = makeStore();
    const svc = new ReminderService(store, { now: () => clock });
    await svc.start();
    const outcomes: Array<(spoken: boolean) => void> = [];
    svc.registerSpeaker("s1", "u", (_t, cb) => {
      if (cb) outcomes.push(cb);
      return true;
    });
    svc.add({ sessionId: "s1", userId: "u", text: "Пить таблетки", fireAt: clock + 1000 });
    clock += 1001;
    vi.advanceTimersByTime(1001);
    outcomes[0]!(true);
    expect(store.awaitingDelivery({ userId: "u" })).toHaveLength(0);
  });

  it("ОТМЕНЁННОЕ владельцем напоминание откатом НЕ воскресает", async () => {
    let clock = 1_000_000;
    const store = makeStore();
    const svc = new ReminderService(store, { now: () => clock });
    await svc.start();
    const r = svc.add({ sessionId: "s1", userId: "u", text: "Пить таблетки", fireAt: clock + 1000 });
    svc.cancel("таблетки", "u");
    store.markFiredUndelivered(r.id, clock); // как если бы пришёл откат
    expect(store.awaitingDelivery({ userId: "u" })).toHaveLength(0);
  });

  it("сработавшее недоставленное напоминание НЕ глушит новую просьбу о том же деле", async () => {
    let clock = new Date("2026-07-29T09:59:00").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    svc.add({ sessionId: "s1", userId: "u", text: "Напоминаю: позвонить маме", fireAt: clock + 60_000 });
    clock += 61_000;
    vi.advanceTimersByTime(61_000); // сработало в тишину (клиент закрыт) → firedAt выставлен
    const next = svc.add({
      sessionId: "s1", userId: "u", text: "Напоминаю: позвонить маме про врача", fireAt: clock + 30 * 60_000,
    });
    expect(next.created).not.toBe(false);
    expect(svc.list("u").some((r) => r.text.includes("про врача"))).toBe(true);
  });

  it("разные ритмы одного дела не схлопываются (каждый день ≠ каждую неделю)", async () => {
    const clock = new Date("2026-07-29T07:00:00").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const daily = svc.add({
      sessionId: "s1", userId: "u", text: "Отчёт",
      fireAt: new Date("2026-07-29T09:00:00").getTime(), repeat: { kind: "daily" },
    });
    const weekly = svc.add({
      sessionId: "s1", userId: "u", text: "Отчёт",
      fireAt: new Date("2026-07-29T09:00:00").getTime(), repeat: { kind: "weekly" },
    });
    expect(weekly.id).not.toBe(daily.id);
    expect(svc.list("u")).toHaveLength(2);
  });

  it("тот же ритм и тот же слот — по-прежнему одна запись (гард ритма не открыл дубли)", async () => {
    const clock = new Date("2026-07-29T07:00:00").getTime();
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const a = svc.add({
      sessionId: "s1", userId: "u", text: "Отчёт",
      fireAt: new Date("2026-07-29T09:00:00").getTime(), repeat: { kind: "interval", seconds: 3600 },
    });
    const b = svc.add({
      sessionId: "s1", userId: "u", text: "Отчёт",
      fireAt: new Date("2026-07-29T09:00:00").getTime(), repeat: { kind: "interval", seconds: 3600 },
    });
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);
  });

  it("add сообщает created — рефлекс не рапортует о том, чего не создавал", async () => {
    let clock = 1_000_000;
    const svc = new ReminderService(makeStore(), { now: () => clock });
    await svc.start();
    const first = svc.add({ sessionId: "s1", userId: "u", text: "Напоминаю: позвонить маме", fireAt: clock + 3600_000 });
    expect(first.created).toBe(true);
    // Другая формулировка того же дела в пределах subject-окна → схлопывание, created:false.
    const second = svc.add({ sessionId: "s1", userId: "u", text: "Позвонить маме, сэр", fireAt: clock + 3600_000 + 600_000 });
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
  });

  it("ПК был выключен: стухшее не звучит, но серия перепланирована на будущее (не умирает молча)", async () => {
    const store = makeStore();
    let clock = new Date("2026-07-29T09:00:00").getTime();
    const svc = new ReminderService(store, { now: () => clock });
    await svc.start();
    svc.registerSpeaker("s1", "u", () => {});
    svc.add({ sessionId: "s1", userId: "u", text: "Таблетки", fireAt: clock + 1000, repeat: { kind: "daily" } });
    await svc.flush();
    svc.stop();

    // Сервер поднялся через трое суток (grace 6ч давно истёк).
    clock = new Date("2026-08-01T15:00:00").getTime();
    const svc2 = new ReminderService(store, { now: () => clock });
    const spoken: string[] = [];
    await svc2.start(); // catchUp: стухшее пропускаем...
    svc2.registerSpeaker("s1", "u", (t) => spoken.push(t));
    expect(spoken).toEqual([]); // ...и НЕ озвучиваем «за вчера»
    const pending = svc2.list("u");
    expect(pending).toHaveLength(1); // ...но серия жива
    expect(pending[0]!.fireAt).toBeGreaterThan(clock); // следующий слот в будущем
  });
});

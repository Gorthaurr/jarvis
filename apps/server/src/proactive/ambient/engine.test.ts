import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AmbientEngine } from "./engine.js";
import { AmbientSeenStore } from "./store.js";
import type { AmbientSignal, AmbientSource } from "./signal.js";

let dirCounter = 0;
function tempStore(): AmbientSeenStore {
  return new AmbientSeenStore(join(tmpdir(), `jarvis-ambient-${process.pid}-${dirCounter++}`));
}

/** Управляемый источник: отдаёт заданный список сигналов; enabled — тумблер. */
function fakeSource(id: string, signals: () => AmbientSignal[], on = true): AmbientSource {
  return { id, label: id, enabled: () => on, poll: async () => signals() };
}

const sig = (over: Partial<AmbientSignal> = {}): AmbientSignal => ({
  sourceId: "src",
  userId: "u1",
  key: "k1",
  title: "Событие",
  salience: 0.9,
  ts: 0,
  ...over,
});

// ФИНАЛЬНОЕ РЕВЬЮ ВОЛНЫ D: календарь ввёл фразы с ОТНОСИТЕЛЬНЫМ временем («через 20 минут») и
// НЕсрочные уведомления, которые очередь озвучки может выбросить, — оба класса раньше молча теряли
// или искажали сообщение (durable-seen уже стоял).
describe("AmbientEngine — время и занятость владельца (волна D)", () => {
  it("протухшее отложенное НЕ зачитывается: «через 20 минут» спустя часы — ложь", async () => {
    let clock = 1_000_000;
    const items = [sig({ key: "meet", title: "Сэр, через 20 мин — Созвон (в 15:00).", ttlMs: 20 * 60_000, ts: clock })];
    const eng = new AmbientEngine([fakeSource("cal", () => items)], tempStore(), { minSalience: 0.5, now: () => clock });
    await eng.tickNow(); // владельца нет → в pending
    const speak = vi.fn();
    clock += 3 * 3600_000; // подключился через три часа
    eng.registerSpeaker("s1", "u1", speak);
    expect(speak).not.toHaveBeenCalled();
  });

  it("НЕпротухшее отложенное зачитывается как раньше", async () => {
    let clock = 1_000_000;
    const items = [sig({ key: "meet", title: "Сэр, через 20 мин — Созвон.", ttlMs: 20 * 60_000, ts: clock })];
    const eng = new AmbientEngine([fakeSource("cal", () => items)], tempStore(), { minSalience: 0.5, now: () => clock });
    await eng.tickNow();
    const speak = vi.fn();
    clock += 60_000; // подключился через минуту
    eng.registerSpeaker("s1", "u1", speak);
    expect(speak).toHaveBeenCalledWith("Сэр, через 20 мин — Созвон.", false, expect.any(Function));
  });

  it("сигнал БЕЗ ttl (счёт, «вам написал X») не протухает никогда — прежнее поведение", async () => {
    let clock = 1_000_000;
    const items = [sig({ key: "bill", title: "Не забудьте оплатить счёт" })];
    const eng = new AmbientEngine([fakeSource("obl", () => items)], tempStore(), { minSalience: 0.5, now: () => clock });
    await eng.tickNow();
    const speak = vi.fn();
    clock += 48 * 3600_000;
    eng.registerSpeaker("s1", "u1", speak);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("владелец ЗАНЯТ → несрочное не отдаём и durable seen НЕ ставим (иначе очередь выбросит и потеряем)", async () => {
    const speak = vi.fn();
    let busy = true;
    const items = [sig({ key: "meet", title: "Сэр, через 20 мин — Созвон." })];
    const eng = new AmbientEngine([fakeSource("cal", () => items)], tempStore(), { minSalience: 0.5 });
    eng.registerSpeaker("s1", "u1", speak, () => busy);
    await eng.tickNow();
    expect(speak).not.toHaveBeenCalled();
    busy = false; // освободился
    await eng.tickNow();
    expect(speak).toHaveBeenCalledWith("Сэр, через 20 мин — Созвон.", false, expect.any(Function));
  });

  // КОНТРОЛЬ-5 (LOW, но потеря навсегда): вся накопленная очередь выливалась разом, очередь озвучки
  // держит лишь несколько несрочных и вытесняет старейшие — а durable-seen мы ставили на ВСЕ.
  it("накопленная пачка отдаётся ПОРЦИЯМИ; остаток не помечается доставленным и звучит позже", async () => {
    let clock = 1_000_000;
    let items: AmbientSignal[] = Array.from({ length: 6 }, (_, i) => sig({ key: `m${i}`, title: `Письмо ${i}` }));
    const eng = new AmbientEngine([fakeSource("mail", () => items)], tempStore(), { minSalience: 0.5, now: () => clock });
    await eng.tickNow(); // владельца нет → всё в pending
    const speak = vi.fn();
    eng.registerSpeaker("s1", "u1", speak);
    const first = speak.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(6); // порция, а не всё разом
    items = []; // источник больше ничего не отдаёт — остаток обязан выйти сам
    clock += 90_000;
    await eng.tickNow();
    expect(speak.mock.calls.length).toBeGreaterThan(first); // хвост не завис
  });

  it("СРОЧНОЕ в пачке не откладывается вместе с остальным", async () => {
    let clock = 1_000_000;
    const items: AmbientSignal[] = [
      ...Array.from({ length: 5 }, (_, i) => sig({ key: `m${i}`, title: `Письмо ${i}` })),
      sig({ key: "bill", title: "Сегодня оплата аренды", urgent: true }),
    ];
    const eng = new AmbientEngine([fakeSource("mix", () => items)], tempStore(), { minSalience: 0.5, now: () => clock });
    await eng.tickNow();
    const speak = vi.fn();
    eng.registerSpeaker("s1", "u1", speak);
    expect(speak.mock.calls.map((c) => c[0])).toContain("Сегодня оплата аренды");
  });

  // КОНТРОЛЬ-6 (HIGH): busy-гард стоял ТОЛЬКО в consider(); порционный флаш помечал доставленным то,
  // что занятому владельцу пайплайн не отдаст и через TTL выбросит → потеря навсегда.
  it("владелец занят при ПОДКЛЮЧЕНИИ → отложенное не отдаём и seen не ставим", async () => {
    let clock = 1_000_000;
    let busy = true;
    const items = [sig({ sourceId: "mail", key: "m1", title: "Сэр, вам письмо от бухгалтерии" })];
    const store = tempStore();
    const eng = new AmbientEngine([fakeSource("mail", () => items)], store, { minSalience: 0.5, now: () => clock });
    await eng.tickNow(); // владельца нет → pending
    const speak = vi.fn();
    eng.registerSpeaker("s1", "u1", speak, () => busy);
    expect(speak).not.toHaveBeenCalled();
    expect(store.has("mail:m1")).toBe(false); // durable-метка НЕ поставлена
    busy = false;
    clock += 90_000;
    await eng.tickNow();
    expect(speak).toHaveBeenCalledWith("Сэр, вам письмо от бухгалтерии", false, expect.any(Function));
  });

  it("бюджет тика: пачка новых сигналов озвучивается частями, остальное НЕ помечается", async () => {
    let clock = 1_000_000;
    const items = Array.from({ length: 6 }, (_, i) => sig({ sourceId: "mail", key: `m${i}`, title: `Письмо ${i}` }));
    const store = tempStore();
    const eng = new AmbientEngine([fakeSource("mail", () => items)], store, { minSalience: 0.5, now: () => clock });
    const speak = vi.fn();
    eng.registerSpeaker("s1", "u1", speak); // владелец на связи и свободен
    await eng.tickNow();
    const first = speak.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(6);
    expect(store.has(`mail:m${first}`)).toBe(false); // не озвученное не помечено
    clock += 90_000;
    await eng.tickNow();
    expect(speak.mock.calls.length).toBeGreaterThan(first); // следующая порция дошла
  });

  // КОНТРОЛЬ-9 (HIGH): «принято в очередь» ещё не «прозвучало» — очередь роняет принятое по TTL, на
  // «стоп» и на смерти сессии. Без отката сигнал считался бы доставленным навсегда.
  it("реплика принята, но НЕ прозвучала → durable-пометка ОТКАТЫВАЕТСЯ и сигнал вернётся", async () => {
    let clock = 1_000_000;
    const items = [sig({ sourceId: "mail", key: "m1", title: "Сэр, вам письмо от бухгалтерии" })];
    const store = tempStore();
    const eng = new AmbientEngine([fakeSource("mail", () => items)], store, { minSalience: 0.5, now: () => clock });
    // Канал «принимает» реплику, но потом сообщает, что она не прозвучала (TTL/стоп/смерть сессии).
    const outcomes: Array<(spoken: boolean) => void> = [];
    eng.registerSpeaker("s1", "u1", (_t, _u, cb) => {
      if (cb) outcomes.push(cb);
      return true;
    });
    await eng.tickNow();
    expect(store.has("mail:m1")).toBe(true); // приняли → помечено
    outcomes[0]!(false); // ...но очередь его сбросила
    expect(store.has("mail:m1")).toBe(false); // откат — сигнал снова «не доставлен»

    const speak = vi.fn(() => true);
    const eng2 = new AmbientEngine([fakeSource("mail", () => items)], store, { minSalience: 0.5, now: () => clock });
    eng2.registerSpeaker("s2", "u1", speak);
    clock += 90_000;
    await eng2.tickNow();
    expect(speak).toHaveBeenCalled(); // и он действительно вернулся к владельцу
  });

  it("прозвучавшая реплика остаётся помеченной (откат только на false)", async () => {
    const items = [sig({ sourceId: "obl", key: "m2", title: "Счёт к оплате" })];
    const store = tempStore();
    const eng = new AmbientEngine([fakeSource("obl", () => items)], store, { minSalience: 0.5 });
    const outcomes: Array<(spoken: boolean) => void> = [];
    eng.registerSpeaker("s1", "u1", (_t, _u, cb) => {
      if (cb) outcomes.push(cb);
      return true;
    });
    await eng.tickNow();
    outcomes[0]!(true);
    expect(store.has("obl:m2")).toBe(true);
  });

  it("СРОЧНОЕ проходит и при занятом владельце (§9 urgent)", async () => {
    const speak = vi.fn();
    const items = [sig({ key: "bill", title: "Сегодня оплата аренды", urgent: true })];
    const eng = new AmbientEngine([fakeSource("obl", () => items)], tempStore(), { minSalience: 0.5 });
    eng.registerSpeaker("s1", "u1", speak, () => true);
    await eng.tickNow();
    expect(speak).toHaveBeenCalledWith("Сегодня оплата аренды", true, expect.any(Function));
  });
});

describe("AmbientEngine — проактивная осведомлённость (дедуп + салиентность + доставка)", () => {
  it("новый салиентный сигнал → проактивно проговорён; повтор того же key → НЕ дублируется", async () => {
    const speak = vi.fn();
    let items: AmbientSignal[] = [sig({ title: "Герман написал в Telegram" })];
    const eng = new AmbientEngine([fakeSource("src", () => items)], tempStore(), { minSalience: 0.5 });
    eng.registerSpeaker("s1", "u1", speak);

    await eng.tickNow();
    expect(speak).toHaveBeenCalledWith("Герман написал в Telegram", false, expect.any(Function));

    await eng.tickNow(); // тот же сигнал ещё висит — НЕ повторяем
    expect(speak).toHaveBeenCalledTimes(1);

    // новое событие (другой key) → новое уведомление
    items = [sig({ key: "k2", title: "Аня написала в Telegram" })];
    await eng.tickNow();
    expect(speak).toHaveBeenCalledTimes(2);
    expect(speak).toHaveBeenLastCalledWith("Аня написала в Telegram", false, expect.any(Function));
  });

  it("аудит-2 [6]: сигнал офлайн-владельцу НЕ помечается durable seen → рестарт до flush не теряет срочное", async () => {
    const store = tempStore();
    const items = [sig({ key: "bill", title: "Не забудьте оплатить счёт", urgent: true })];
    // владелец ОФЛАЙН (speaker не зарегистрирован) — сигнал уходит в pending
    const eng = new AmbientEngine([fakeSource("src", () => items)], store, { minSalience: 0.5 });
    await eng.tickNow();
    // durable «seen» НЕ поставлен (иначе рестарт до flush потеряет срочный сигнал навсегда на TTL)
    expect(store.has("src:bill")).toBe(false);
    // «рестарт»: НОВЫЙ движок на том же (не помеченном) сторе + владелец онлайн → сигнал пере-доставляется
    const speak = vi.fn();
    const eng2 = new AmbientEngine([fakeSource("src", () => items)], store, { minSalience: 0.5 });
    eng2.registerSpeaker("s1", "u1", speak);
    await eng2.tickNow();
    expect(speak).toHaveBeenCalledWith("Не забудьте оплатить счёт", true, expect.any(Function));
    expect(store.has("src:bill")).toBe(true); // теперь ДОСТАВЛЕНО → durable seen
  });

  it("ниже порога салиентности → НЕ тревожим владельца", async () => {
    const speak = vi.fn();
    const eng = new AmbientEngine([fakeSource("src", () => [sig({ salience: 0.2 }), sig({ key: "k2", salience: 0.8 })])], tempStore(), {
      minSalience: 0.5,
    });
    eng.registerSpeaker("s1", "u1", speak);
    await eng.tickNow();
    expect(speak).toHaveBeenCalledTimes(1); // только важный (0.8), не 0.2
  });

  it("urgent проходит флагом true (даже когда пользователь занят, §9)", async () => {
    const speak = vi.fn();
    const eng = new AmbientEngine([fakeSource("src", () => [sig({ urgent: true, title: "Счёт к оплате СЕГОДНЯ" })])], tempStore());
    eng.registerSpeaker("s1", "u1", speak);
    await eng.tickNow();
    expect(speak).toHaveBeenCalledWith("Счёт к оплате СЕГОДНЯ", true, expect.any(Function));
  });

  it("нет активной сессии → отложено; доставлено владельцу при подключении (изоляция по userId)", async () => {
    const eng = new AmbientEngine([fakeSource("src", () => [sig({ title: "Важное" })])], tempStore());
    await eng.tickNow(); // speaker не зарегистрирован
    const mine = vi.fn();
    const other = vi.fn();
    eng.registerSpeaker("sOther", "uOther", other);
    expect(other).not.toHaveBeenCalled(); // чужому не отдаём
    eng.registerSpeaker("s1", "u1", mine);
    expect(mine).toHaveBeenCalledWith("Важное", false, expect.any(Function));
  });

  it("phraser формулирует фразу ТОЛЬКО на новое важное (не на тик); ошибка фразировщика → берём title", async () => {
    const speak = vi.fn();
    const phraser = vi.fn(async (s: AmbientSignal) => `Сэр, ${s.title.toLowerCase()}.`);
    const eng = new AmbientEngine([fakeSource("src", () => [sig({ title: "Герман написал" })])], tempStore(), { phraser });
    eng.registerSpeaker("s1", "u1", speak);
    await eng.tickNow();
    expect(phraser).toHaveBeenCalledTimes(1); // ровно на одно новое событие
    expect(speak).toHaveBeenCalledWith("Сэр, герман написал.", false, expect.any(Function));
    await eng.tickNow(); // повтор — фразировщик НЕ зовётся (дедуп до него)
    expect(phraser).toHaveBeenCalledTimes(1);
  });

  it("выключенный источник пропускается (тумблер)", async () => {
    const speak = vi.fn();
    const eng = new AmbientEngine([fakeSource("off", () => [sig()], false)], tempStore());
    eng.registerSpeaker("s1", "u1", speak);
    await eng.tickNow();
    expect(speak).not.toHaveBeenCalled();
  });

  it("M13: engine.flush() дренирует seen-стор → после рестарта не кричит повторно (без store.flush())", async () => {
    const dir = join(tmpdir(), `jarvis-ambient-flush-${process.pid}-${dirCounter++}`);
    const speak1 = vi.fn();
    const eng1 = new AmbientEngine([fakeSource("src", () => [sig({ title: "Счёт" })])], new AmbientSeenStore(dir), {});
    eng1.registerSpeaker("s1", "u1", speak1);
    await eng1.tickNow();
    expect(speak1).toHaveBeenCalledTimes(1);
    await eng1.flush(); // M13: дренируем через сервис (gateway.close зовёт именно его)

    const speak2 = vi.fn();
    const store2 = new AmbientSeenStore(dir);
    await store2.load();
    const eng2 = new AmbientEngine([fakeSource("src", () => [sig({ title: "Счёт" })])], store2, {});
    eng2.registerSpeaker("s2", "u1", speak2);
    await eng2.tickNow();
    expect(speak2).not.toHaveBeenCalled(); // durable дедуп сработал (flush записал seen)
  });

  it("durable: сообщённое переживает перезагрузку (после рестарта не кричит повторно)", async () => {
    const dir = join(tmpdir(), `jarvis-ambient-durable-${process.pid}-${dirCounter++}`);
    const speak1 = vi.fn();
    const store1 = new AmbientSeenStore(dir);
    const eng1 = new AmbientEngine([fakeSource("src", () => [sig({ title: "Счёт" })])], store1, {});
    eng1.registerSpeaker("s1", "u1", speak1);
    await eng1.tickNow();
    expect(speak1).toHaveBeenCalledTimes(1);
    await store1.flush();

    // «рестарт»: новый движок на том же каталоге — тот же сигнал НЕ повторяем
    const speak2 = vi.fn();
    const store2 = new AmbientSeenStore(dir);
    await store2.load();
    const eng2 = new AmbientEngine([fakeSource("src", () => [sig({ title: "Счёт" })])], store2, {});
    eng2.registerSpeaker("s2", "u1", speak2);
    await eng2.tickNow();
    expect(speak2).not.toHaveBeenCalled(); // durable дедуп сработал
  });
});

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

describe("AmbientEngine — проактивная осведомлённость (дедуп + салиентность + доставка)", () => {
  it("новый салиентный сигнал → проактивно проговорён; повтор того же key → НЕ дублируется", async () => {
    const speak = vi.fn();
    let items: AmbientSignal[] = [sig({ title: "Герман написал в Telegram" })];
    const eng = new AmbientEngine([fakeSource("src", () => items)], tempStore(), { minSalience: 0.5 });
    eng.registerSpeaker("s1", "u1", speak);

    await eng.tickNow();
    expect(speak).toHaveBeenCalledWith("Герман написал в Telegram", false);

    await eng.tickNow(); // тот же сигнал ещё висит — НЕ повторяем
    expect(speak).toHaveBeenCalledTimes(1);

    // новое событие (другой key) → новое уведомление
    items = [sig({ key: "k2", title: "Аня написала в Telegram" })];
    await eng.tickNow();
    expect(speak).toHaveBeenCalledTimes(2);
    expect(speak).toHaveBeenLastCalledWith("Аня написала в Telegram", false);
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
    expect(speak).toHaveBeenCalledWith("Счёт к оплате СЕГОДНЯ", true);
  });

  it("нет активной сессии → отложено; доставлено владельцу при подключении (изоляция по userId)", async () => {
    const eng = new AmbientEngine([fakeSource("src", () => [sig({ title: "Важное" })])], tempStore());
    await eng.tickNow(); // speaker не зарегистрирован
    const mine = vi.fn();
    const other = vi.fn();
    eng.registerSpeaker("sOther", "uOther", other);
    expect(other).not.toHaveBeenCalled(); // чужому не отдаём
    eng.registerSpeaker("s1", "u1", mine);
    expect(mine).toHaveBeenCalledWith("Важное", false);
  });

  it("phraser формулирует фразу ТОЛЬКО на новое важное (не на тик); ошибка фразировщика → берём title", async () => {
    const speak = vi.fn();
    const phraser = vi.fn(async (s: AmbientSignal) => `Сэр, ${s.title.toLowerCase()}.`);
    const eng = new AmbientEngine([fakeSource("src", () => [sig({ title: "Герман написал" })])], tempStore(), { phraser });
    eng.registerSpeaker("s1", "u1", speak);
    await eng.tickNow();
    expect(phraser).toHaveBeenCalledTimes(1); // ровно на одно новое событие
    expect(speak).toHaveBeenCalledWith("Сэр, герман написал.", false);
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

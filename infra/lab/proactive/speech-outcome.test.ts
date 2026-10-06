/**
 * Исход озвучки через НАСТОЯЩУЮ очередь: «прозвучало» - это первый чанк звука клиенту. Принято очередью, но TTS упал /
 * закончил без звука / очередь сброшена «стоп»-ом -> дело снова ждёт доставки и звучит РОВНО один раз позже.
 * Три исхода реплики (аналог «ушло / не ушло / неизвестно»): прозвучало, отказано очередью, принято-но-не-прозвучало.
 */
import { describe, it } from "vitest";
import { OWNER, remind, useLab } from "./helpers.js";
import { expect } from "./kit.js";

const HOUR = 3_600_000;
const outcomes = (lab: ReturnType<typeof useLab>["lab"]): unknown[] => lab.journal.of("outcome").map((e) => e.detail?.spoken);

describe("исход реплики напоминания", () => {
  const t = useLab();

  it("прозвучало: исход true, дело закрыто, повторов нет", async () => {
    const { lab } = t;
    lab.connect();
    remind(lab, "Пить таблетки", 1_000);
    await lab.clock.advance(1_000);
    expect(outcomes(lab)).toEqual([true]);
    expect(lab.spoken()).toEqual(["Пить таблетки"]);
    expect(lab.svc.reminders.list(OWNER)).toEqual([]);
    await lab.clock.advance(HOUR);
    expect(lab.spoken()).toHaveLength(1);
    expect(lab.logs.filter((l) => l.includes("напоминание озвучено"))).toHaveLength(1);
  });

  it("TTS упал: исход false, дело ждёт снова, через 20 с (дренаж) звучит ровно один раз", async () => {
    const { lab } = t;
    lab.tts.mode = "fail";
    lab.connect();
    const r = remind(lab, "Пить таблетки", 1_000);
    await lab.clock.advance(1_000);
    expect(outcomes(lab)).toEqual([false]);
    expect(lab.spoken()).toEqual([]);
    expect(lab.svc.reminders.list(OWNER)).toHaveLength(1); // не потеряно, ждёт доставки
    lab.tts.mode = "speak"; // синтез восстановился
    await lab.clock.advance(19_999);
    expect(lab.spoken()).toEqual([]);
    await lab.clock.advance(1);
    expect(lab.spoken()).toEqual(["Пить таблетки"]);
    expect(lab.journal.soundTimes()).toEqual([r.fireAt + 20_000]);
    expect(lab.svc.reminders.list(OWNER)).toEqual([]);
    await lab.clock.advance(HOUR);
    expect(lab.spoken()).toHaveLength(1);
  });

  it("синтез закончился БЕЗ единого чанка: не считается озвученным, повторяется", async () => {
    const { lab } = t;
    lab.tts.mode = "mute-end";
    lab.connect();
    remind(lab, "Позвонить маме", 1_000);
    await lab.clock.advance(1_000);
    expect(outcomes(lab)).toEqual([false]);
    lab.tts.mode = "speak";
    await lab.clock.advance(20_000);
    expect(lab.spoken()).toEqual(["Позвонить маме"]);
  });

  it("принято, но звука ещё нет: журнал видит queued без sound, дело числится доставленным лишь после первого чанка", async () => {
    const { lab } = t;
    lab.tts.mode = "hold";
    lab.connect();
    remind(lab, "Выключить плиту", 1_000);
    await lab.clock.advance(1_000);
    expect(lab.journal.of("queued")).toHaveLength(1);
    expect(outcomes(lab)).toEqual([]); // исход неизвестен, пока нет ни звука, ни отказа
    expect(lab.spoken()).toEqual([]);
    lab.tts.last?.emitChunk();
    expect(outcomes(lab)).toEqual([true]);
    expect(lab.spoken()).toEqual(["Выключить плиту"]);
  });

  it("«стоп» владельца сбрасывает очередь: непроизнесённые возвращаются в ожидание и звучат позже по одному разу", async () => {
    const { lab } = t;
    lab.tts.mode = "hold"; // первая реплика «говорит» и держит канал, вторая ждёт в очереди
    const owner = lab.connect();
    remind(lab, "первое дело", 1_000);
    remind(lab, "второе дело", 1_000);
    await lab.clock.advance(1_000);
    expect(lab.journal.of("queued")).toHaveLength(2);
    owner.voice.clearPendingSpeech(); // «отмени»/«стоп»: очередь сброшена, источник узнаёт false
    expect(outcomes(lab)).toEqual([false]); // сброшена именно ожидавшая, не говорящая
    lab.tts.mode = "speak";
    lab.tts.last?.emitChunk();
    lab.tts.last?.finish();
    await lab.clock.advance(60_000);
    expect(lab.spoken().sort()).toEqual(["второе дело", "первое дело"].sort());
    await lab.clock.advance(HOUR);
    expect(lab.spoken()).toHaveLength(2);
  });
});

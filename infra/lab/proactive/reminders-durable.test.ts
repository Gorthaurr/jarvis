/**
 * Пробелы долговечности напоминаний (найдено лабораторией). Кейсы с ДЕФЕКТ - ожидание по закону («принято ≠ прозвучало»,
 * durable не теряется молча); на текущем продукте они КРАСНЫЕ (LAB_DEFECTS=1), в обычном прогоне пропущены.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { ReminderService } from "../../../apps/server/src/proactive/reminders/service.js";
import { ReminderStore } from "../../../apps/server/src/proactive/reminders/store.js";
import { OWNER, remind, remindAt, useLab } from "./helpers.js";
import { DEFECTS, expect } from "./kit.js";

const MIN = 60_000;

describe("принято очередью, но звука ещё нет", () => {
  const t = useLab();

  it("штатная остановка: сессия умерла до звука - откат доставки записан, после рестарта звучит один раз", async () => {
    const { lab } = t;
    lab.tts.mode = "hold"; // синтез ничего не отдаёт: реплика принята, звука нет
    const owner = lab.connect();
    remind(lab, "Принять лекарство", 1_000);
    await lab.clock.advance(1_000);
    expect(lab.journal.of("queued")).toHaveLength(1);
    expect(lab.spoken()).toEqual([]);
    owner.disconnect(); // dispose пайплайна: onOutcome(false) -> запись снова «ждёт доставки»
    await lab.restart();
    lab.tts.mode = "speak";
    lab.connect();
    await lab.clock.advance(5_000);
    expect(lab.spoken()).toEqual(["Принять лекарство"]);
  });

  it.skipIf(!DEFECTS)("ДЕФЕКТ: процесс умер между «принято очередью» и первым звуком - срочное напоминание потеряно навсегда (done пишется при приёме)", async () => {
    const { lab } = t;
    lab.tts.mode = "hold";
    lab.connect();
    remind(lab, "Принять лекарство", 1_000);
    await lab.clock.advance(1_000);
    expect(lab.journal.of("queued")).toHaveLength(1); // приняла очередь, но звука не было
    expect(lab.spoken()).toEqual([]);
    await lab.crash(); // kill -9 / падение: onOutcome(false) уже никто не вызовет
    lab.tts.mode = "speak";
    lab.connect();
    await lab.clock.advance(5 * MIN);
    expect(lab.spoken()).toEqual(["Принять лекарство"]); // закон: не прозвучало = не доставлено
  });
});

describe("файл напоминаний: несколько писателей и порча", () => {
  const t = useLab();
  const service = (lab: ReturnType<typeof useLab>["lab"]): ReminderService => new ReminderService(new ReminderStore(lab.dataDir), { now: () => Date.now() });

  it.skipIf(!DEFECTS)("ДЕФЕКТ D1: второй экземпляр на том же каталоге затирает запись первого (last-writer-wins) - напоминание пропадает с диска", async () => {
    const { lab } = t;
    const loser = service(lab);
    await loser.start(); // загрузил ПУСТОЙ снимок, как проигравший порт экземпляр
    remind(lab, "первое дело", 10 * MIN); // писатель А
    await lab.flush();
    loser.add({ sessionId: "s0", userId: OWNER, text: "второе дело", fireAt: lab.clock.now() + 20 * MIN }); // писатель Б
    await loser.flush();
    loser.stop();
    await lab.restart();
    expect(lab.svc.reminders.list(OWNER).map((r) => r.text).sort()).toEqual(["второе дело", "первое дело"]); // закон: ничего не теряем
  });

  it("битый reminders.json: сервис стартует и работает, новые дела сохраняются", async () => {
    const { lab } = t;
    writeFileSync(`${lab.dataDir}/reminders.json`, '[{"id":"a","userId":"owner","text":"обрыв', "utf8");
    await lab.restart();
    remind(lab, "новое дело", 10 * MIN);
    await lab.flush();
    await lab.restart();
    expect(lab.svc.reminders.list(OWNER).map((r) => r.text)).toEqual(["новое дело"]);
  });

  it.skipIf(!DEFECTS)("ДЕФЕКТ D2: битый reminders.json стирается первой же записью без копии - содержимое невосстановимо", async () => {
    const { lab } = t;
    const broken = '[{"id":"a","userId":"owner","text":"важное дело","fireAt":1,"status":"scheduled","createdAt":0},{"id":"b","use';
    writeFileSync(`${lab.dataDir}/reminders.json`, broken, "utf8");
    await lab.restart();
    remind(lab, "новое дело", 10 * MIN);
    await lab.flush();
    const kept = readdirSync(lab.dataDir).some((f) => f !== "reminders.json" && existsSync(`${lab.dataDir}/${f}`) && readFileSync(`${lab.dataDir}/${f}`, "utf8").includes("важное дело"));
    expect(kept).toBe(true); // закон: нечитаемое состояние не уничтожают молча
  });
});

describe("сон ПК: настенные часы прыгнули, таймеры стояли", () => {
  const t = useLab({ start: "2026-07-29T08:00:00" });

  it("ПОЛИТИКА D7: дело на 09:00 после 8-часового сна звучит поздно, но не теряется и не дублируется (при рестарте старше 6 ч его бы пропустили)", async () => {
    const { lab } = t;
    lab.connect();
    remindAt(lab, "Выпей воды", "2026-07-29T09:00:00");
    lab.clock.jump(8 * 60 * MIN); // ПК уснул в 08:00 и проснулся в 16:00
    expect(lab.spoken()).toEqual([]); // таймер сам не сработал
    await lab.clock.advance(60 * MIN);
    expect(lab.spoken()).toEqual(["Выпей воды"]);
    expect(lab.journal.soundTimes()[0]!).toBeGreaterThanOrEqual(lab.clock.at("2026-07-29T16:00:00"));
    await lab.clock.advance(3 * 60 * MIN);
    expect(lab.spoken()).toHaveLength(1);
  });
});

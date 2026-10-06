/**
 * «Ночь офлайна»: три источника (напоминания, наблюдения, ambient) накопили 12 реплик, владелец подключился - и все три
 * сервиса разом льют в ОДНУ очередь озвучки (QUEUE_MAX=4). Закон: ничего не потеряно, ничего не продублировано, каждая
 * реплика прозвучала ровно раз; отказ очереди = «не доставлено, повторим», а не «доставлено».
 */
import { describe, it } from "vitest";
import type { AmbientSignal } from "../../../apps/server/src/proactive/ambient/signal.js";
import { OWNER, remindAt, useLab, watch } from "./helpers.js";
import { expect } from "./kit.js";
import type { ProactiveLab } from "./lab.js";

const MIN = 60_000;
const REMINDERS = ["Позвонить маме", "Оплатить интернет", "Купить хлеб", "Сдать отчёт", "Полить цветы"];
const WATCHES = ["Курс биткоина", "Статус заказа", "Погода в Казани"];
const AMBIENT = ["Вам написал Герман", "Пришло письмо от банка", "Через час созвон с командой"];
const URGENT = "Срочно оплатить счёт за свет";

const sig = (key: string, title: string, urgent = false): AmbientSignal => ({
  sourceId: "lab", userId: OWNER, key, title, salience: 0.8, ts: Date.now(), ...(urgent ? { urgent: true } : {}),
});

/** Ночь без владельца: всё сработало в тишину и лежит недоставленным в трёх сервисах. */
async function nightOffline(lab: ProactiveLab): Promise<string[]> {
  REMINDERS.forEach((text, i) => remindAt(lab, text, `2026-07-29T02:0${i}:00`));
  lab.script.checker = async (w) => ({ met: Date.now() >= lab.clock.at("2026-07-29T03:00:00"), summary: `${w.what}: условие выполнено.` });
  for (const what of WATCHES) watch(lab, { what, condition: "условие", intervalMs: MIN });
  await lab.clock.advanceTo("2026-07-29T03:30:00");
  lab.script.signals = [...AMBIENT.map((t, i) => sig(`a${i}`, t)), sig("u0", URGENT, true)];
  await lab.clock.advanceTo("2026-07-29T08:00:00");
  expect(lab.spoken()).toEqual([]); // ночью говорить некому
  return [...REMINDERS, ...WATCHES.map((w) => `${w}: условие выполнено.`), ...AMBIENT, URGENT];
}

describe("залп после ночи офлайна через общую очередь", () => {
  const t = useLab({ start: "2026-07-29T01:00:00", ambientIntervalMs: 90_000 });

  it("12 реплик из трёх сервисов: каждая звучит ровно один раз, очередь реально переполнялась и отказывала", async () => {
    const { lab } = t;
    const expected = await nightOffline(lab);
    lab.connect();
    await lab.clock.advance(20 * MIN);
    expect([...lab.spoken()].sort()).toEqual([...expected].sort()); // ни потерь, ни повторов
    expect(lab.journal.of("refused").length).toBeGreaterThan(0); // залп упёрся в QUEUE_MAX: дренаж отработал по-настоящему
    await lab.clock.advance(3 * 60 * MIN);
    expect(lab.spoken()).toHaveLength(expected.length); // и позже не дублируется
  });

  it("сессия умерла посреди залпа: недоговорённое возвращается, после переподключения дослушано без повторов", async () => {
    const { lab } = t;
    const expected = await nightOffline(lab);
    const first = lab.connect();
    await lab.clock.advance(4_000); // успело прозвучать 2-3 реплики
    const heard = lab.spoken().length;
    expect(heard).toBeGreaterThan(0);
    expect(heard).toBeLessThan(expected.length);
    first.disconnect(); // обрыв: ожидавшие в очереди получают onOutcome(false)
    lab.connect();
    await lab.clock.advance(30 * MIN);
    expect([...lab.spoken()].sort()).toEqual([...expected].sort());
  });
});

describe("«не мешать» при подключении в звонке", () => {
  const t = useLab({ start: "2026-07-29T01:00:00", ambientIntervalMs: 90_000 });

  it("занятому владельцу звучит срочное (напоминания, наблюдения, срочный ambient), несрочный ambient ждёт и звучит после освобождения", async () => {
    const { lab } = t;
    const expected = await nightOffline(lab);
    const owner = lab.connect({ busy: true });
    await lab.clock.advance(5 * MIN);
    const duringCall = lab.spoken();
    expect(duringCall).toContain(URGENT);
    for (const a of AMBIENT) expect(duringCall).not.toContain(a); // несрочное придержано, а не «доставлено в никуда»
    expect(duringCall).toHaveLength(expected.length - AMBIENT.length);
    owner.busy = false; // звонок закончился
    await lab.clock.advance(5 * MIN);
    expect([...lab.spoken()].sort()).toEqual([...expected].sort());
  });
});

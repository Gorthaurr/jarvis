/**
 * Кому проактив звучит: только владельцу (по userId, а не по sessionId), ровно на одном устройстве; dev-сессия
 * текст-драйвера и чужой пользователь - не получатели и ничего не «съедают».
 */
import { describe, it } from "vitest";
import type { AmbientSignal } from "../../../apps/server/src/proactive/ambient/signal.js";
import { OWNER, remind, useLab, watch } from "./helpers.js";
import { expect } from "./kit.js";

const MIN = 60_000;
const message = (): AmbientSignal => ({ sourceId: "lab", userId: OWNER, key: "k", title: "Вам написала Мария", salience: 0.8, ts: Date.now() });

describe("получатели проактива", () => {
  const t = useLab({ start: "2026-07-29T08:00:00" });

  it("dev-сессия (текст-драйвер) не получатель: напоминание, наблюдение и ambient дожидаются настоящего владельца", async () => {
    const { lab } = t;
    lab.connect({ dev: true });
    lab.script.checker = async () => ({ met: true, summary: "Заказ доставлен." });
    remind(lab, "Выпей воды", MIN);
    watch(lab, { intervalMs: MIN });
    lab.script.signals = [message()];
    await lab.clock.advance(10 * MIN);
    expect(lab.spoken()).toEqual([]); // никто не «съел» ночные события
    lab.connect();
    await lab.clock.advance(3 * MIN);
    expect([...lab.spoken()].sort()).toEqual(["Вам написала Мария", "Выпей воды", "Заказ доставлен."]);
  });

  it("чужой пользователь ничего не слышит из дел владельца, даже если подключён первым", async () => {
    const { lab } = t;
    const intruder = lab.connect({ userId: "intruder" });
    const owner = lab.connect();
    remind(lab, "личное дело владельца", MIN);
    lab.script.signals = [message()];
    await lab.clock.advance(5 * MIN);
    expect(lab.journal.spokenBy(intruder.sessionId)).toEqual([]);
    expect(lab.journal.spokenBy(owner.sessionId).sort()).toEqual(["Вам написала Мария", "личное дело владельца"]);
  });

  it("два устройства владельца: дело звучит ровно на одном, не дублируется", async () => {
    const { lab } = t;
    const a = lab.connect();
    const b = lab.connect();
    remind(lab, "Позвонить маме", MIN);
    lab.script.signals = [message()];
    await lab.clock.advance(5 * MIN);
    expect(lab.spoken().sort()).toEqual(["Вам написала Мария", "Позвонить маме"]);
    expect(lab.journal.spokenBy(a.sessionId).length + lab.journal.spokenBy(b.sessionId).length).toBe(2);
  });

  it("устройство отключилось до срока, вместо него подключилось другое: дело звучит на новом (доставка по владельцу)", async () => {
    const { lab } = t;
    const old = lab.connect();
    remind(lab, "Позвонить маме", 5 * MIN);
    await lab.clock.advance(MIN);
    old.disconnect();
    const fresh = lab.connect();
    await lab.clock.advance(10 * MIN);
    expect(lab.journal.spokenBy(fresh.sessionId)).toEqual(["Позвонить маме"]);
    expect(lab.spoken()).toHaveLength(1);
  });
});

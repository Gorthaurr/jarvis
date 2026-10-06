/**
 * Тихие часы ambient (JARVIS_QUIET_HOURS, здесь "23-9") на виртуальных часах: несрочное не звучит ночью И НЕ теряется
 * (seen не ставится, звучит ровно в 09:00), срочное и привязанное ко времени проходят, напоминания/наблюдения окно не гасит
 * (политика D6), окно следует локальному поясу сервера.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "vitest";
import type { AmbientSignal } from "../../../apps/server/src/proactive/ambient/signal.js";
import { OWNER, remindAt, useLab, watch } from "./helpers.js";
import { expect } from "./kit.js";
import type { ProactiveLab } from "./lab.js";

const MIN = 60_000;
const sig = (key: string, title: string, extra: Partial<AmbientSignal> = {}): AmbientSignal => ({
  sourceId: "lab", userId: OWNER, key, title, salience: 0.8, ts: Date.now(), ...extra,
});
/** Ключи, о которых durable сказано «доставлено» (ambient-seen.json на диске). */
async function seen(lab: ProactiveLab): Promise<string[]> {
  await lab.flush();
  const f = `${lab.dataDir}/ambient-seen.json`;
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Array<{ key: string }>).map((e) => e.key) : [];
}
const at = (lab: ProactiveLab): string[] => lab.journal.soundTimes().map((x) => lab.clock.fmt(x).slice(5, 19));

describe("тихие часы 23-9", () => {
  const t = useLab({ start: "2026-07-29T22:00:00", tz: "Europe/Moscow", quietHours: "23-9", ambientIntervalMs: MIN });

  it("граница 23:00: сигнал до неё звучит, после - ждёт; в 09:00:00 ровно один раз, seen ставится только после звука", async () => {
    const { lab } = t;
    lab.connect();
    await lab.clock.advanceTo("2026-07-29T22:58:30");
    lab.script.signals = [sig("a", "Письмо от Германа")];
    await lab.clock.advanceTo("2026-07-29T22:59:30");
    lab.script.signals.push(sig("b", "Письмо от банка"));
    await lab.clock.advanceTo("2026-07-30T08:59:59");
    expect(lab.spoken()).toEqual(["Письмо от Германа"]); // «a» успело до 23:00, «b» - в тихом окне
    expect(await seen(lab)).toEqual(["lab:a"]); // «b» НЕ помечено доставленным - иначе потеряется
    await lab.clock.advanceTo("2026-07-30T09:00:00");
    expect(lab.spoken()).toEqual(["Письмо от Германа", "Письмо от банка"]);
    expect(at(lab)).toEqual(["07-29 22:59:00", "07-30 09:00:00"]);
    expect(await seen(lab)).toEqual(["lab:a", "lab:b"]);
    await lab.clock.advance(3 * 60 * MIN);
    expect(lab.spoken()).toHaveLength(2);
  });

  it("срочное и привязанное ко времени (ttl) проходят ночью на ближайшем тике", async () => {
    const { lab } = t;
    lab.connect();
    await lab.clock.advanceTo("2026-07-30T02:00:00");
    lab.script.signals = [sig("u", "Срочно: счёт сгорает", { urgent: true }), sig("m", "Скоро созвон с командой", { ttlMs: 30 * MIN })];
    await lab.clock.advance(MIN + 5_000);
    expect(lab.spoken()).toEqual(["Срочно: счёт сгорает", "Скоро созвон с командой"]); // срочное первым, очередь одна
    expect(at(lab)).toEqual(["07-30 02:01:00", "07-30 02:01:02"]); // оба на первом же тике, вторая - вслед за первой
  });

  it("напоминание и наблюдение тихие часы НЕ гасят (заказаны владельцем на время; политика D6)", async () => {
    const { lab } = t;
    lab.connect();
    remindAt(lab, "Разбудить к поезду", "2026-07-30T03:00:00");
    lab.script.checker = async () => ({ met: Date.now() >= lab.clock.at("2026-07-30T03:30:00"), summary: "Заказ доставлен." });
    watch(lab, { intervalMs: MIN });
    await lab.clock.advanceTo("2026-07-30T04:00:00");
    expect(lab.spoken()).toEqual(["Разбудить к поезду", "Заказ доставлен."]);
    expect(at(lab)).toEqual(["07-30 03:00:00", "07-30 03:30:00"]);
  });

  it("владельца не было ночью, подключился в 02:00: несрочное держится до утра и звучит один раз", async () => {
    const { lab } = t;
    await lab.clock.advanceTo("2026-07-29T23:30:00");
    lab.script.signals = [sig("k", "Вам написала Мария")];
    await lab.clock.advanceTo("2026-07-30T02:00:00"); // сигнал ушёл в pending (канала нет)
    lab.connect();
    await lab.clock.advanceTo("2026-07-30T08:59:59");
    expect(lab.spoken()).toEqual([]);
    await lab.clock.advanceTo("2026-07-30T09:01:00");
    expect(lab.spoken()).toEqual(["Вам написала Мария"]);
    expect(at(lab)).toEqual(["07-30 09:00:00"]);
  });

  it("сервер упал и поднялся ночью: придержанное несрочное не забыто и звучит утром", async () => {
    const { lab } = t;
    lab.connect();
    await lab.clock.advanceTo("2026-07-29T23:30:00");
    lab.script.signals = [sig("k", "Вам написала Мария")];
    await lab.clock.advanceTo("2026-07-30T03:00:00");
    await lab.crash();
    lab.connect();
    await lab.clock.advanceTo("2026-07-30T09:01:00");
    expect(lab.spoken()).toEqual(["Вам написала Мария"]);
    expect(at(lab)).toEqual(["07-30 09:00:00"]);
  });

  it("окно считается по локальному поясу сервера: 23:30 по Москве - тихо, тот же момент в Нью-Йорке (16:30) - звучит", async () => {
    const { lab } = t;
    lab.connect();
    await lab.clock.advanceTo("2026-07-29T23:30:00");
    lab.script.signals = [sig("k", "Вам написала Мария")];
    await lab.clock.advance(2 * MIN);
    expect(lab.spoken()).toEqual([]);
    lab.clock.setTz("America/New_York");
    await lab.clock.advance(MIN);
    expect(lab.spoken()).toEqual(["Вам написала Мария"]);
  });
});

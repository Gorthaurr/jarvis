/**
 * Killswitch автономии («полный стоп»): замораживает наблюдения, ambient и доставку их уведомлений/поручений, но НЕ напоминания
 * (заказаны на время). Латч durable и fail-closed. Снятие «включи автономию» ничего не теряет.
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { autonomyFreeze } from "../../../apps/server/src/autonomy/freeze.js";
import type { CheckResult } from "../../../apps/server/src/proactive/watch/watch.js";
import type { AmbientSignal } from "../../../apps/server/src/proactive/ambient/signal.js";
import { OWNER, autonomyResume, autonomyStop, remind, useLab, watch } from "./helpers.js";
import { expect } from "./kit.js";

const MIN = 60_000;
const message: AmbientSignal = { sourceId: "lab", userId: OWNER, key: "k", title: "Вам написала Мария", salience: 0.8, ts: 0 };

describe("killswitch", () => {
  const t = useLab({ start: "2026-07-29T08:00:00" });

  it("под латчем: проверки наблюдения и ambient молчат, напоминание звучит; после снятия догоняется всё", async () => {
    const { lab } = t;
    lab.connect();
    let checks = 0;
    lab.script.checker = async () => (checks++, { met: true, summary: "Заказ доставлен." });
    autonomyStop();
    watch(lab, { intervalMs: MIN });
    lab.script.signals = [{ ...message, ts: Date.now() }];
    remind(lab, "Разбудить к поезду", 5 * MIN);
    await lab.clock.advance(10 * MIN);
    expect(checks).toBe(0); // наблюдение заморожено
    expect(lab.spoken()).toEqual(["Разбудить к поезду"]); // напоминание - нет (заказано на время)
    autonomyResume(lab);
    await lab.clock.advance(90_000);
    expect(checks).toBe(1);
    expect(lab.spoken()).toEqual(["Разбудить к поезду", "Заказ доставлен.", "Вам написала Мария"]); // ничего не потеряно
  });

  it("стоп посреди проверки: уведомление и поручение запаркованы, после «включи автономию» выполняются по одному разу", async () => {
    const { lab } = t;
    lab.connect();
    let release!: (r: CheckResult) => void;
    lab.script.checker = () => new Promise<CheckResult>((res) => (release = res));
    watch(lab, { what: "статус заказа", intervalMs: MIN, action: "напиши Кате" });
    await lab.clock.advance(1); // проверка пошла и висит
    autonomyStop(); // владелец сказал «полный стоп», пока проверка в полёте
    release({ met: true, summary: "Заказ доставлен." });
    await lab.clock.advance(5_000);
    expect(lab.spoken()).toEqual([]); // после стопа автономия молчит
    expect(lab.journal.goals()).toEqual([]); // и поручение людям не уходит
    autonomyResume(lab);
    await lab.clock.advance(1_000);
    expect(lab.spoken()).toEqual(["Заказ доставлен."]);
    expect(lab.journal.goals()).toHaveLength(1);
    await lab.clock.advance(60 * MIN);
    expect(lab.spoken()).toHaveLength(1);
    expect(lab.journal.goals()).toHaveLength(1);
  });

  it("латч переживает рестарт; повреждённый файл латча = стоп стоит (fail-closed); снятие удаляет файл", async () => {
    const { lab } = t;
    lab.connect();
    let checks = 0;
    lab.script.checker = async () => (checks++, { met: false, summary: "" });
    autonomyStop();
    await lab.restart();
    expect(autonomyFreeze().isFrozen()).toBe(true);
    const file = `${lab.dataDir}/autonomy-freeze.json`;
    writeFileSync(file, "{битый", "utf8");
    await lab.restart();
    expect(autonomyFreeze().isFrozen()).toBe(true);
    watch(lab, { intervalMs: MIN });
    await lab.clock.advance(10 * MIN);
    expect(checks).toBe(0);
    expect(autonomyResume(lab)).toBe(true);
    expect(existsSync(file)).toBe(false);
    await lab.restart();
    expect(autonomyFreeze().isFrozen()).toBe(false);
  });

  it("D14 (по замыслу): удалить файл латча руками на работающем сервере - стоп остаётся в силе до команды владельца", async () => {
    const { lab } = t;
    autonomyStop();
    unlinkSync(`${lab.dataDir}/autonomy-freeze.json`);
    expect(autonomyFreeze().isFrozen()).toBe(true);
  });
});

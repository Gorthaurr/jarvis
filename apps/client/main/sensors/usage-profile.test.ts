/**
 * W4.2: накопитель фокуса — считает секунды по процессу, переживает перезапуск через файл, честный days.
 * Реверт-проверка: убери `ms / 1000` (пиши ms как секунды) — минуты в первом кейсе уедут в 12× — упадёт.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageProfile, focusCountable } from "./usage-profile.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "jarvis-usage-"));
  dirs.push(d);
  return join(d, "usage-profile.json");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("UsageProfile", () => {
  it("тики складываются в минуты по процессу; unknown/пусто не считаются; топ по убыванию", () => {
    let t = 1_000_000;
    const u = new UsageProfile(tmp(), () => t);
    for (let i = 0; i < 50; i++) u.tick("chrome", 12_000); // 600 с = 10 мин
    for (let i = 0; i < 10; i++) u.tick("Telegram", 12_000); // 2 мин
    u.tick("unknown", 12_000);
    u.tick(undefined, 12_000);
    u.tick("Code", -5);
    t += 2 * 86_400_000; // двое суток
    expect(u.top(5)).toEqual([
      { process: "chrome", minutes: 10, days: 2 },
      { process: "Telegram", minutes: 2, days: 2 },
    ]);
  });

  it("flush пишет файл, новый экземпляр читает его и продолжает счёт с прежним since", () => {
    const path = tmp();
    const t0 = 5_000_000;
    const a = new UsageProfile(path, () => t0);
    a.tick("obs64", 60_000);
    a.flush();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ v: 1, since: t0, seconds: { obs64: 60 } });
    const b = new UsageProfile(path, () => t0 + 86_400_000);
    b.tick("obs64", 60_000);
    expect(b.top(1)).toEqual([{ process: "obs64", minutes: 2, days: 1 }]);
  });

  it("битый файл — не ошибка: счёт начинается заново", () => {
    const path = tmp();
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(path, "{not json", "utf8");
    const u = new UsageProfile(path, () => 1);
    u.tick("x", 1000);
    expect(u.top(1)[0]?.process).toBe("x");
  });

  it("H-W1: фокус считается только когда владелец за ПК — «отошёл», «не знаю» (ввод Джарвиса) и блокировка не считаются", () => {
    const u = new UsageProfile(tmp(), () => 1);
    expect(u.tickFocus("chrome", 60_000, { presence: "away", locked: false })).toBe(false); // ночь, браузер открыт
    expect(u.tickFocus("Discord", 60_000, { presence: "unknown", locked: false })).toBe(false); // окно двигал Джарвис
    expect(u.tickFocus("LockApp", 60_000, { presence: "at_pc", locked: true })).toBe(false); // экран заблокирован
    expect(u.tickFocus("Code", 60_000, { presence: "at_pc", locked: false })).toBe(true);
    expect(u.top(5)).toEqual([{ process: "Code", minutes: 1, days: 0 }]);
    expect(focusCountable("at_pc", false)).toBe(true);
  });
});

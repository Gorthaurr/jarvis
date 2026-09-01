import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutonomyFreeze, matchAutonomyCommand } from "./freeze.js";

// Волна E: killswitch автономии — durable-латч, переживающий рестарт; снять может только владелец.
describe("AutonomyFreeze — durable-латч", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-freeze-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("freeze ставит латч, «рестарт» (новый инстанс на том же каталоге) его ВИДИТ", () => {
    const a = new AutonomyFreeze(dir);
    expect(a.isFrozen()).toBe(false);
    a.freeze("команда владельца");
    expect(a.isFrozen()).toBe(true);
    const restarted = new AutonomyFreeze(dir); // симуляция рестарта сервера
    expect(restarted.isFrozen()).toBe(true);
    expect(restarted.info()?.reason).toContain("владельца");
  });

  it("unfreeze снимает латч durable (и подтверждает диск)", () => {
    const a = new AutonomyFreeze(dir);
    a.freeze("x");
    expect(a.unfreeze()).toBe(true);
    expect(a.isFrozen()).toBe(false);
    expect(new AutonomyFreeze(dir).isFrozen()).toBe(false); // рестарт стопа не воскрешает
  });

  it("битый файл латча = СТОП стоит (fail-closed — порча JSON не снимает аварийный стоп)", () => {
    writeFileSync(join(dir, "autonomy-freeze.json"), "{оборвано", "utf8");
    const a = new AutonomyFreeze(dir);
    expect(a.isFrozen()).toBe(true);
    expect(a.info()?.reason).toContain("fail-closed");
  });
});

describe("matchAutonomyCommand — позитивный anchored-словарь", () => {
  it("команды стопа узнаются (вкл. пунктуацию/регистр и парафразы контроль-ревью)", () => {
    for (const t of [
      "полный стоп",
      "Полный стоп!",
      "аварийный стоп",
      "стоп автономия",
      "стоп автономию",
      "стоп вся автономия",
      "останови автономию",
      "останови всю автономию",
      "выключи автономию",
      "отключи автономию",
      "заморозь автономию",
    ]) {
      expect(matchAutonomyCommand(t)).toBe("freeze");
    }
  });
  it("команды включения узнаются", () => {
    for (const t of [
      "включи автономию",
      "включи автономию обратно",
      "верни автономию",
      "запусти автономию",
      "разморозь автономию",
      "сними полный стоп",
      "сними аварийный стоп",
    ]) {
      expect(matchAutonomyCommand(t)).toBe("unfreeze");
    }
  });
  it("обычное управление задачами/плеером НЕ съедается (якорь всей фразы)", () => {
    for (const t of ["стоп", "останови задачу", "останови музыку", "полный стоп производства в Китае", "включи музыку", "продолжи", "отмени напоминание"]) {
      expect(matchAutonomyCommand(t)).toBeNull();
    }
  });
});

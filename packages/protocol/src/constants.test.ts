/**
 * Таймауты команд — контракт сервер↔клиент (§5): серверный потолок обязан быть СТРОГО выше клиентского бюджета,
 * иначе успешное действие рапортуется таймаутом, а ретрай модели его дублирует.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ACTION_TIMEOUT_MS, SKILL_EXECUTE_SERVER_TIMEOUT_MS, actionTimeoutMs } from "./constants.js";

describe("actionTimeoutMs — таблица потолков", () => {
  const table: Array<[string, number]> = [
    // W2 G-20: запуск ждёт окно (≤5 с) поверх hard-25 с лаунчера — 30 с уже не хватало бы.
    ["app.launch", 36_000],
    ["skill.execute", SKILL_EXECUTE_SERVER_TIMEOUT_MS],
    ["gui.act", 60_000],
    ["wait.for", 130_000],
    ["screen.ocr", 25_000],
    ["screen.selection", 25_000],
    ["ui.snapshot", 20_000],
    ["app.close", 20_000],
    ["app.focus", 20_000],
    ["browser.open", 20_000],
    ["fs.search", 60_000],
    ["fs.view", 30_000],
    ["input.click", 30_000],
    ["input.type", 30_000],
    ["input.mouse", 30_000],
    ["input.key", 30_000],
    ["ui.invoke", 30_000],
    ["window.list", DEFAULT_ACTION_TIMEOUT_MS],
  ];
  it.each(table)("%s → %i мс", (kind, ms) => {
    expect(actionTimeoutMs(kind)).toBe(ms);
  });

  it("app.launch строго выше hard-таймаута лаунчера (25 с) + ожидания окна (5 с)", () => {
    expect(actionTimeoutMs("app.launch")).toBeGreaterThan(25_000 + 5_000);
  });

  it("skill.execute — 130 с (строго выше клиентского бюджета реплея 80 с + хвоста шага)", () => {
    expect(SKILL_EXECUTE_SERVER_TIMEOUT_MS).toBe(130_000);
  });
});

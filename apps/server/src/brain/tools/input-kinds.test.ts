import { describe, expect, it } from "vitest";
import type { ActionKind } from "@jarvis/protocol";
import { kindNeedsInput, toolNeedsInput } from "./input-kinds.js";

describe("классификация аренды ввода (§20)", () => {
  it("GUI-команды (мышь/клава/фокус/окно/скилл/чекаут) требуют аренды", () => {
    const inputKinds: ActionKind[] = [
      "input.type",
      "input.key",
      "input.click",
      "ui.invoke",
      "app.launch",
      "app.focus",
      "browser.open",
      "browser.act",
      "skill.execute",
      "order.place",
    ];
    for (const k of inputKinds) expect(kindNeedsInput(k)).toBe(true);
  });

  it("чтение/файлы/код/память/Office/system не требуют аренды (параллелятся)", () => {
    const free: ActionKind[] = [
      "browser.read",
      "ui.ground",
      "context.read",
      "code.run",
      "fs.read",
      "fs.write",
      "fs.delete",
      "office.word",
      "office.excel",
      "system.lock",
      "system.media",
      "system.clipboard",
      "message.send",
    ];
    for (const k of free) expect(kindNeedsInput(k)).toBe(false);
  });

  it("toolNeedsInput по имени: GUI-инструменты → true, серверные/код/файлы → false", () => {
    expect(toolNeedsInput("app_launch")).toBe(true);
    expect(toolNeedsInput("input_click")).toBe(true);
    expect(toolNeedsInput("skill_execute")).toBe(true);
    expect(toolNeedsInput("order_place")).toBe(true);
    // Серверные инструменты не эмитят ActionCommand → ввод свободен.
    expect(toolNeedsInput("web_search")).toBe(false);
    expect(toolNeedsInput("memory_search")).toBe(false);
    expect(toolNeedsInput("fs_write")).toBe(false);
    expect(toolNeedsInput("code_run")).toBe(false);
    // Неизвестное имя (самописный инструмент → code.run) — не блокирует ввод.
    expect(toolNeedsInput("totally_made_up")).toBe(false);
  });
});

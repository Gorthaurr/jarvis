import { describe, expect, it } from "vitest";
import type { ActionKind } from "@jarvis/protocol";
import { INPUT_BEARING_KINDS, kindNeedsInput, toolNeedsInput } from "./input-kinds.js";

/**
 * 🔴 Аудит тестовой базы 2026-09-01: прежний тест перечислял 10 видов из 13 — выпали `input.mouse`
 * (та самая мышь, ради которой §20-арбитраж и существует), `app.close` и `window.focus`. Их удаление
 * из набора прогон не заметил бы: две фоновые задачи начали бы драться за курсор и фокус окна.
 * Поэтому здесь пиннится ПОЛНЫЙ состав: удалил вид — тест падает; добавил — обязан обновить осознанно.
 */
describe("классификация аренды ввода (§20)", () => {
  it("состав видов, требующих аренды, зафиксирован целиком", () => {
    expect([...INPUT_BEARING_KINDS].sort()).toEqual(
      [
        "app.close",
        "app.focus",
        "app.launch",
        "browser.act",
        "browser.open",
        "input.click",
        "input.key",
        "input.mouse",
        "input.type",
        "order.place",
        "skill.execute",
        "ui.invoke",
        "window.focus",
      ].sort(),
    );
  });

  it("каждый из них действительно требует аренды через kindNeedsInput", () => {
    for (const k of INPUT_BEARING_KINDS) expect(kindNeedsInput(k)).toBe(true);
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

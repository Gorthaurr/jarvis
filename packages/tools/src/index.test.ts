/**
 * Тесты определений инструментов (§6, §12, §8).
 * Проверяем: форму tool-use, уникальность имён, покрытие всех ActionKind,
 * корректность input_schema и наличие гардов §14 в описаниях.
 */

import { describe, it, expect } from "vitest";
import type { ActionKind } from "@jarvis/protocol";

import {
  TOOL_SCHEMAS,
  TOOLS_BY_NAME,
  ACTUATOR_TOOL_BY_KIND,
  ACTUATOR_TOOL_NAMES,
} from "./index.js";

describe("@jarvis/tools — форма и инварианты", () => {
  it("у каждого инструмента есть name/description/input_schema", () => {
    expect(TOOL_SCHEMAS.length).toBeGreaterThan(0);
    for (const t of TOOL_SCHEMAS) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.input_schema).toBeTypeOf("object");
      expect(t.input_schema).not.toBeNull();
    }
  });

  it("имена инструментов уникальны", () => {
    const names = TOOL_SCHEMAS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("TOOLS_BY_NAME согласован с TOOL_SCHEMAS", () => {
    expect(Object.keys(TOOLS_BY_NAME).length).toBe(TOOL_SCHEMAS.length);
    for (const t of TOOL_SCHEMAS) {
      expect(TOOLS_BY_NAME[t.name]).toBe(t);
    }
  });

  it("каждый input_schema — JSON Schema object с properties", () => {
    for (const t of TOOL_SCHEMAS) {
      expect(t.input_schema["type"]).toBe("object");
      expect(t.input_schema["properties"]).toBeTypeOf("object");
    }
  });
});

describe("@jarvis/tools — покрытие актуаторов (§6)", () => {
  it("покрыты ВСЕ ActionKind", () => {
    // compile-time: ACTUATOR_TOOL_BY_KIND типизирован как Record<ActionKind, string>,
    // поэтому пропуск любого kind не скомпилируется. Здесь — runtime-страховка.
    const expectedKinds: ActionKind[] = [
      "input.type",
      "input.key",
      "input.click",
      "ui.invoke",
      "ui.ground",
      "app.launch",
      "app.focus",
      "browser.open",
      "browser.act",
      "browser.read",
      "code.run",
      "skill.execute",
      "screen.capture",
      "context.read",
      "demo.record",
      "message.send",
      "order.place",
    ];
    for (const kind of expectedKinds) {
      const toolName = ACTUATOR_TOOL_BY_KIND[kind];
      expect(toolName, `нет инструмента для kind=${kind}`).toBeTruthy();
      expect(TOOLS_BY_NAME[toolName], `инструмент ${toolName} не зарегистрирован`).toBeDefined();
    }
    expect(Object.keys(ACTUATOR_TOOL_BY_KIND).length).toBe(expectedKinds.length);
  });

  it("все актуаторные инструменты существуют в наборе", () => {
    for (const name of ACTUATOR_TOOL_NAMES) {
      expect(TOOLS_BY_NAME[name]).toBeDefined();
    }
  });
});

describe("@jarvis/tools — server-side инструменты (§12, §8)", () => {
  it("присутствуют web- и memory-инструменты", () => {
    for (const name of ["web_search", "web_fetch", "memory_search", "memory_write"]) {
      expect(TOOLS_BY_NAME[name], `нет инструмента ${name}`).toBeDefined();
    }
  });
});

describe("@jarvis/tools — гарды §14 закодированы в описаниях", () => {
  it("message_send требует confirm и упоминает cadence", () => {
    const d = TOOLS_BY_NAME["message_send"]!.description.toLowerCase();
    expect(d).toContain("confirm");
    expect(d).toContain("cadence");
  });

  it("order_place требует confirm, spend cap и не трогает карту", () => {
    const d = TOOLS_BY_NAME["order_place"]!.description.toLowerCase();
    expect(d).toContain("confirm");
    expect(d).toContain("spend cap");
    expect(d).toContain("идемпотент");
    // запрет на карточные/платёжные реквизиты (§0 принцип 5)
    expect(d).toContain("платёжн");
  });

  it("code_run помечает powershell как confirm + CLM", () => {
    const d = TOOLS_BY_NAME["code_run"]!.description;
    expect(d).toContain("powershell");
    expect(d.toLowerCase()).toContain("confirm");
    expect(d).toContain("CLM");
  });
});

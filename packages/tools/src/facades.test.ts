/**
 * W4 «Руки»: фасады look/window/audio → канонические инструменты; потолок горячего набора.
 * Реверт-проверка: сними «ui_snapshot» из COLD — тест потолка упадёт; замени `{ ...i }` на `i` в
 * canonicalToolCall — тест «не мутирует вход» упадёт.
 */
import { describe, expect, it } from "vitest";
import { COLD_TOOL_NAMES, FACADE_TOOL_NAMES, HOT_TOOL_CEILING, TOOLS_BY_NAME, canonicalToolCall, canonicalToolName, hotToolNames } from "./index.js";

describe("canonicalToolCall", () => {
  it("look: elements/text/windows/context → ui_snapshot/screen_read_text/window_list/context_read с нужными полями", () => {
    expect(canonicalToolCall("look", { what: "elements", pid: 7, maxItems: 50, rect: { x: 1 } })).toEqual({ name: "ui_snapshot", input: { pid: 7, maxItems: 50 } });
    expect(canonicalToolCall("look", { what: "text", monitor: "1", rect: { x: 1, y: 2, w: 3, h: 4 }, lang: "ru" })).toEqual({ name: "screen_read_text", input: { monitor: "1", rect: { x: 1, y: 2, w: 3, h: 4 }, lang: "ru" } });
    expect(canonicalToolCall("look", { what: "windows", pid: 7 })).toEqual({ name: "window_list", input: {} });
    expect(canonicalToolCall("look", { what: "context" })).toEqual({ name: "context_read", input: { scope: "active_window" } });
    expect(canonicalToolCall("look", { what: "context", scope: "selection" })).toEqual({ name: "context_read", input: { scope: "selection" } });
  });

  it("window: focus/list/minimize|maximize|restore|move → window_focus/window_list/window_arrange", () => {
    expect(canonicalToolCall("window", { op: "focus", query: "Блокнот" })).toEqual({ name: "window_focus", input: { query: "Блокнот" } });
    expect(canonicalToolCall("window", { op: "focus", hwnd: 5 })).toEqual({ name: "window_focus", input: { hwnd: 5 } });
    expect(canonicalToolCall("window", { op: "list" })).toEqual({ name: "window_list", input: {} });
    expect(canonicalToolCall("window", { op: "move", query: "chrome", monitor: 1, maximizeAfterMove: true })).toEqual({
      name: "window_arrange",
      input: { query: "chrome", monitor: 1, maximizeAfterMove: true, op: "move" },
    });
    expect(canonicalToolCall("window", { op: "minimize", hwnd: 9 })).toEqual({ name: "window_arrange", input: { hwnd: 9, op: "minimize" } });
  });

  it("audio: list/set → audio_sessions/audio_set", () => {
    expect(canonicalToolCall("audio", { op: "list" })).toEqual({ name: "audio_sessions", input: {} });
    expect(canonicalToolCall("audio", { op: "set", process: "chrome", mute: true, level: 0.3 })).toEqual({ name: "audio_set", input: { process: "chrome", mute: true, level: 0.3 } });
  });

  it("неизвестный what/op → имя фасада как есть (dispatch ответит честной ошибкой, не выберет наугад); не-фасад → как есть", () => {
    expect(canonicalToolCall("look", { what: "everything" }).name).toBe("look");
    expect(canonicalToolCall("window", {}).name).toBe("window");
    expect(canonicalToolCall("act", { target: "x" })).toEqual({ name: "act", input: { target: "x" } });
    expect(canonicalToolName("fs_read", { path: "a" })).toBe("fs_read");
  });

  it("W1: browser_tabs{op:'close'} → browser_close (tabId/url); list/без op — сам browser_tabs", () => {
    expect(canonicalToolCall("browser_tabs", { op: "close", tabId: 7, junk: 1 })).toEqual({ name: "browser_close", input: { tabId: 7 } });
    expect(canonicalToolCall("browser_tabs", { op: "close", url: "youtube.com" })).toEqual({ name: "browser_close", input: { url: "youtube.com" } });
    expect(canonicalToolCall("browser_tabs", { op: "list" })).toEqual({ name: "browser_tabs", input: { op: "list" } });
    expect(canonicalToolCall("browser_tabs", {})).toEqual({ name: "browser_tabs", input: {} });
  });

  it("НЕ мутирует вход: объект SDK остаётся прежним (по нему сопоставляется хендлер канала подписки)", () => {
    const input = { what: "elements", pid: 3 };
    const c = canonicalToolCall("look", input);
    expect(c.input).not.toBe(input);
    expect(input).toEqual({ what: "elements", pid: 3 });
    const pass = { path: "a" };
    expect(canonicalToolCall("fs_read", pass).input).not.toBe(pass);
  });
});

describe("горячий набор (W4.3)", () => {
  it(`не больше ${HOT_TOOL_CEILING} горячих схем; фасады и act горячие, их канонические цели — в COLD`, () => {
    const hot = hotToolNames();
    expect(hot.length, hot.join(" ")).toBeLessThanOrEqual(HOT_TOOL_CEILING);
    for (const f of [...FACADE_TOOL_NAMES, "act", "input_key", "screen_capture", "wait_for"]) expect(hot, f).toContain(f);
    for (const cold of ["ui_snapshot", "screen_read_text", "window_list", "context_read", "window_focus", "window_arrange", "audio_sessions", "audio_set", "ui_invoke", "input_click", "input_type", "input_mouse", "app_focus"]) {
      expect(COLD_TOOL_NAMES.has(cold), cold).toBe(true);
      expect(TOOLS_BY_NAME[cold], cold).toBeDefined(); // канонический инструмент существует — dispatch исполнит
    }
  });

  // W1: ref-режим единственный → берст форм горячий; закрытие вкладок — фасадом browser_tabs{op:"close"}, имя
  // browser_close осталось (старые навыки) в COLD. Потолок 60 держится обменом, а не ростом.
  it("W1: browser_batch горячий, browser_close холодный (цель фасада browser_tabs op:close); схемы W1 на месте", () => {
    const hot = hotToolNames();
    expect(hot).toContain("browser_batch");
    expect(hot).toContain("browser_tabs");
    expect(COLD_TOOL_NAMES.has("browser_close")).toBe(true);
    expect(TOOLS_BY_NAME.browser_close).toBeDefined();
    const act = TOOLS_BY_NAME.browser_act!.input_schema as { properties: Record<string, { enum?: string[] }> };
    for (const i of ["set", "key", "hover", "scroll_to", "back", "forward"]) expect(act.properties.intent?.enum, i).toContain(i);
    for (const f of ["ref", "selector", "text", "value", "checked", "combo", "option", "enter", "params", "tabId"]) expect(act.properties[f], f).toBeDefined();
    const read = TOOLS_BY_NAME.browser_read!.input_schema as { properties: Record<string, { enum?: string[] }>; required?: string[] };
    expect(read.properties.view?.enum).toEqual(["text", "image"]);
    expect(read.required ?? []).not.toContain("selectorIntent"); // картинке фильтр текста не нужен
    const tabs = TOOLS_BY_NAME.browser_tabs!.input_schema as { properties: Record<string, { enum?: string[] }> };
    expect(tabs.properties.op?.enum).toEqual(["list", "close"]);
  });
});

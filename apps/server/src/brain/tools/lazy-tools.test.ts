import { describe, expect, it } from "vitest";
import { COLD_TOOL_NAMES, TOOLS_BY_NAME, toolCatalogLine } from "@jarvis/tools";
import { dispatchTool, type ToolContext } from "./dispatch.js";

function ctx(activation: Set<string>): ToolContext {
  return { userId: "u1", toolActivation: activation } as unknown as ToolContext;
}

// §15 ленивая загрузка: холодные инструменты вне горячего набора, подгружаются tool_load.
describe("tool_load — ленивая загрузка (§15)", () => {
  it("каталог-строка компактна (имя + первая фраза)", () => {
    const t = TOOLS_BY_NAME.obs_request;
    expect(t).toBeTruthy();
    const line = toolCatalogLine(t!);
    expect(line.startsWith("- obs_request:")).toBe(true);
    expect(line.length).toBeLessThan(140);
  });

  it("известный ХОЛОДНЫЙ инструмент → добавляется в activation (доступен со след. хода)", async () => {
    const a = new Set<string>();
    const cold = [...COLD_TOOL_NAMES][0]!; // напр. demo_record/obs_request
    const r = await dispatchTool("tool_load", { names: [cold] }, ctx(a));
    expect(r.isError).toBe(false);
    expect(a.has(cold)).toBe(true);
    expect(String(r.content)).toMatch(/Загружен/i);
  });

  it("ГОРЯЧИЙ инструмент → уже активен, в activation НЕ кладём", async () => {
    const a = new Set<string>();
    const r = await dispatchTool("tool_load", { names: ["web_search"] }, ctx(a)); // web_search горячий
    expect(a.has("web_search")).toBe(false);
    expect(String(r.content)).toMatch(/уже активн/i);
  });

  it("неизвестное имя → честно «не найдено», не падает", async () => {
    const a = new Set<string>();
    const r = await dispatchTool("tool_load", { names: ["нет_такого_инструмента"] }, ctx(a));
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/не найден/i);
  });

  it("пустой/без names → честная ошибка", async () => {
    const r = await dispatchTool("tool_load", {}, ctx(new Set()));
    expect(r.isError).toBe(true);
  });

  it("COLD_TOOL_NAMES — только реально существующие инструменты", () => {
    for (const name of COLD_TOOL_NAMES) {
      expect(TOOLS_BY_NAME[name], `cold tool ${name} должен существовать`).toBeTruthy();
    }
  });
});

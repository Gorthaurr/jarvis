/**
 * W2 (пакет 0): поля схем GUI-инструментов и allowlist по схеме.
 * Каждый кейс падает на прежней реализации: дубли в wait_for, `space` в целях/регионах, нет `steps`/новых глаголов,
 * сборка команды «всё, что прислала модель».
 */
import { describe, expect, it } from "vitest";
import { ACT_VERBS, TOOLS_BY_NAME, hotToolNames, pickBySchema, toolInputFields } from "./index.js";
import { SCREEN_RECT_SCHEMA, TARGET_SCHEMA } from "./gui-schemas.js";

type S = Record<string, any>;
const act = TOOLS_BY_NAME["act"]!.input_schema as S;

/** Все имена свойств схемы на любой глубине (properties / oneOf / anyOf / items). */
function allPropNames(schema: unknown, out = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== "object") return out;
  const s = schema as S;
  if (s.properties) for (const [k, v] of Object.entries(s.properties)) (out.add(k), allPropNames(v, out));
  for (const alt of [s.oneOf, s.anyOf]) if (Array.isArray(alt)) for (const b of alt) allPropNames(b, out);
  if (s.items) allPropNames(s.items, out);
  return out;
}

describe("W2 схемы: поля", () => {
  it("G-18: каждый kind условия wait_for описан в тексте РОВНО один раз (file/process были повторены трижды)", () => {
    const w = TOOLS_BY_NAME["wait_for"]!;
    const kinds = ((w.input_schema as S).properties.condition.oneOf as S[]).map((b) => b.properties.kind.const as string);
    expect(kinds.length).toBeGreaterThanOrEqual(8);
    for (const k of kinds) {
      const n = w.description.split(`'${k}' (`).length - 1;
      expect(n, `kind '${k}' в описании wait_for`).toBe(1);
    }
  });

  it("горячий бюджет «описание + JSON схемы» ≤ 71 125 + 1K (на подписке схема едет в описании)", () => {
    let total = 0;
    for (const n of hotToolNames()) total += TOOLS_BY_NAME[n]!.description.length + JSON.stringify(TOOLS_BY_NAME[n]!.input_schema).length;
    expect(total).toBeLessThanOrEqual(71_125 + 1_000);
  });

  it("нет `space` в act (target/to), TARGET и RECT — вместо него `frame`", () => {
    for (const [label, schema] of [["act", act], ["TARGET", TARGET_SCHEMA], ["RECT", SCREEN_RECT_SCHEMA], ["input_mouse", TOOLS_BY_NAME["input_mouse"]!.input_schema]] as const) {
      const names = allPropNames(schema);
      expect(names.has("space"), `${label}: space`).toBe(false);
      expect(names.has("frame"), `${label}: frame`).toBe(true);
    }
  });

  it("act: steps (≤ 12, свободный объект), новые глаголы, clear/enter/to/dx/dy/observe", () => {
    expect(act.properties.steps).toMatchObject({ type: "array", maxItems: 12, items: { type: "object", additionalProperties: true } });
    expect(act.properties.steps.description.length).toBeLessThanOrEqual(260);
    expect(act.properties.do.enum).toEqual([...ACT_VERBS]);
    for (const v of ["triple", "middle", "hover", "drag", "scroll"]) expect(act.properties.do.enum).toContain(v);
    for (const f of ["clear", "enter", "to", "dx", "dy", "observe", "app"]) expect(act.properties[f], f).toBeDefined();
    expect(act.properties.commitApproved).toBeUndefined();
  });

  it("G-17: ui_invoke без scroll (UIA-прокрутка сайдкара только вниз) — прокрутка через act{do:'scroll'}", () => {
    const ui = TOOLS_BY_NAME["ui_invoke"]!.input_schema as S;
    expect(ui.properties.pattern.enum).toEqual(["invoke", "setValue", "select", "toggle", "expand"]);
    expect(act.properties.do.enum).toContain("scroll");
  });
});

describe("W2 allowlist по схеме (toolInputFields / pickBySchema)", () => {
  it("toolInputFields: поля схемы, без служебных; неизвестный инструмент — пусто", () => {
    const f = toolInputFields("input_key");
    expect([...f].sort()).toEqual(["combo", "mode", "scancode"].filter((k) => f.has(k)).sort());
    expect(f.has("combo")).toBe(true);
    expect(toolInputFields("act").has("approval")).toBe(false);
    expect(toolInputFields("нет_такого").size).toBe(0);
  });

  it("pickBySchema режет лишнее на любой глубине закрытой схемы, свободные объекты не трогает", () => {
    const input = {
      target: { by: "coords", x: 1, y: 2, space: "screen", approval: { grants: [] } },
      method: "physical",
      commitApproved: true,
      expectedForeground: 5,
    };
    expect(pickBySchema(TOOLS_BY_NAME["input_click"]!.input_schema, input)).toEqual({ target: { by: "coords", x: 1, y: 2 }, method: "physical" });
    const a = pickBySchema(act, { target: { text: "Ок", space: "screen", frame: "f1" }, to: { x: 1, y: 2, space: "screen" }, approval: {} });
    expect(a).toEqual({ target: { text: "Ок", frame: "f1" }, to: { x: 1, y: 2 } });
    // Строковая цель act и свободный params (input_batch) — как есть.
    expect(pickBySchema(act, { target: "Отправить" })).toEqual({ target: "Отправить" });
    const b = pickBySchema(TOOLS_BY_NAME["input_batch"]!.input_schema, { steps: [{ action: "wait", params: { ms: 5, any: 1 }, junk: 1 }] });
    expect(b).toEqual({ steps: [{ action: "wait", params: { ms: 5, any: 1 } }] });
  });

  it("вход не мутируется (у канала подписки хендлер SDK сверяет исходный объект аргументов)", () => {
    const input = { combo: "Enter", approval: { grants: [] } };
    const copy = JSON.parse(JSON.stringify(input));
    pickBySchema(TOOLS_BY_NAME["input_key"]!.input_schema, input);
    expect(input).toEqual(copy);
  });
});

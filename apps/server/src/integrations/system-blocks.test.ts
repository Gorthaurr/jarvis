import { describe, expect, it } from "vitest";
import { buildSystemBlocks } from "./anthropic.js";

const CC = { type: "ephemeral" } as const;

// §15: раскладка system-блоков и постановка cache_control — раньше жила приватно в buildArgs
// и не покрывалась тестами (дыра из аудита кеша). Теперь — прямой юнит-тест чистой функции.
describe("buildSystemBlocks — кеш-брейкпоинты system (§15)", () => {
  it("только персона → один блок с cache_control", () => {
    const b = buildSystemBlocks({ systemStatic: "PERSONA" }, CC);
    expect(b).toHaveLength(1);
    expect(b[0]).toEqual({ type: "text", text: "PERSONA", cache_control: CC });
  });

  it("персона + навык → ДВА кешируемых блока в порядке [персона, навык]", () => {
    const b = buildSystemBlocks({ systemStatic: "PERSONA", systemSkill: "SKILL" }, CC);
    expect(b).toHaveLength(2);
    expect(b[0]!.text).toBe("PERSONA");
    expect(b[0]!.cache_control).toEqual(CC);
    expect(b[1]!.text).toBe("SKILL");
    expect(b[1]!.cache_control).toEqual(CC); // навык — СВОЙ кеш-брейкпоинт (главный фикс экономии)
  });

  it("персона + навык + динамика → динамика идёт ПОСЛЕДНЕЙ и БЕЗ cache_control", () => {
    const b = buildSystemBlocks(
      { systemStatic: "PERSONA", systemSkill: "SKILL", systemDynamic: "DYN" },
      CC,
    );
    expect(b.map((x) => x.text)).toEqual(["PERSONA", "SKILL", "DYN"]);
    expect(b[0]!.cache_control).toEqual(CC);
    expect(b[1]!.cache_control).toEqual(CC);
    expect(b[2]!.cache_control).toBeUndefined(); // динамика не кешируется → не ломает кеш-хит
  });

  it("cachePrefix=false → НИ ОДИН блок не кешируется (тощий префикс, не платим 1.25×)", () => {
    const b = buildSystemBlocks(
      { systemStatic: "P", systemSkill: "S", systemDynamic: "D", cachePrefix: false },
      CC,
    );
    expect(b.every((x) => x.cache_control === undefined)).toBe(true);
  });

  it("ttl 1h пробрасывается в cache_control", () => {
    const cc1h = { type: "ephemeral", ttl: "1h" } as const;
    const b = buildSystemBlocks({ systemStatic: "P", systemSkill: "S" }, cc1h);
    expect(b[0]!.cache_control).toEqual(cc1h);
    expect(b[1]!.cache_control).toEqual(cc1h);
  });

  it("нет навыка → блока навыка нет (между персоной и динамикой)", () => {
    const b = buildSystemBlocks({ systemStatic: "P", systemDynamic: "D" }, CC);
    expect(b.map((x) => x.text)).toEqual(["P", "D"]);
  });
});

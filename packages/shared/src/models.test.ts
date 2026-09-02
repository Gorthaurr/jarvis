import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, findModel, isKnownModel, resolveTierModels } from "./models.js";

const DEFAULTS = { haiku: "claude-sonnet-4-6", sonnet: "claude-sonnet-4-6", fable: "claude-opus-4-8" };

describe("каталог моделей", () => {
  it("id уникальны и без дат-суффиксов", () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toMatch(/\d{8}$/);
  });

  it("findModel — точный id, регистр игнорируется; подстрока НЕ матчит", () => {
    expect(findModel("claude-fable-5-1")?.price.input).toBe(10);
    expect(findModel("CLAUDE-SONNET-5")?.price.output).toBe(10);
    expect(findModel("claude-sonnet")).toBeUndefined();
    expect(isKnownModel("gpt-4o")).toBe(false);
  });
});

describe("resolveTierModels — выбор пользователя поверх лестницы тиров", () => {
  it("пусто/undefined = дефолт", () => {
    const r = resolveTierModels(DEFAULTS, undefined);
    expect(r.models).toEqual(DEFAULTS);
    expect(r.rejected).toEqual([]);
    expect(r.collapsed).toBe(false);
    expect(resolveTierModels(DEFAULTS, { primary: "", strong: "  " }).models).toEqual(DEFAULTS);
  });

  it("primary → слоты haiku+sonnet, strong → fable", () => {
    const r = resolveTierModels(DEFAULTS, { primary: "claude-sonnet-5", strong: "claude-opus-5" });
    expect(r.models).toEqual({ haiku: "claude-sonnet-5", sonnet: "claude-sonnet-5", fable: "claude-opus-5" });
    expect(r.primary).toBe("claude-sonnet-5");
    expect(r.strong).toBe("claude-opus-5");
  });

  it("неизвестный id ОТКЛОНЯЕТСЯ с причиной, слот остаётся дефолтным", () => {
    const r = resolveTierModels(DEFAULTS, { primary: "gpt-4o" });
    expect(r.models).toEqual(DEFAULTS);
    expect(r.rejected).toEqual([{ slot: "primary", id: "gpt-4o", reason: "unknown" }]);
  });

  it("id вне allowlist плана отклоняется как not_allowed", () => {
    const allowed = new Set(["claude-sonnet-4-6", "claude-sonnet-5"]);
    const r = resolveTierModels(DEFAULTS, { primary: "claude-sonnet-5", strong: "claude-fable-5-1" }, allowed);
    expect(r.models.sonnet).toBe("claude-sonnet-5");
    expect(r.rejected).toEqual([{ slot: "strong", id: "claude-fable-5-1", reason: "not_allowed" }]);
    // Отклонённый слот НЕ остаётся на дефолте вне тарифа: дефолтная сильная модель (Opus) плану не
    // разрешена, значит применяется лучшая разрешённая (живой прогон 2026-09-02 — см. тест ниже).
    expect(allowed.has(r.models.fable)).toBe(true);
  });

  it("🔴 тариф ограничивает и ДЕФОЛТНУЮ лестницу, а не только явный выбор (живой дефект 2026-09-02)", () => {
    // Без фикса: выбора нет, allowed=[sonnet…], а models.fable остаётся claude-opus-4-8 — эскалация §7
    // молча уходит на модель вне тарифа (пользователю солгали, владельцу выставили счёт вдвое).
    const allowed = new Set(["claude-sonnet-4-6", "claude-sonnet-5"]);
    const r = resolveTierModels(DEFAULTS, undefined, allowed);
    expect(allowed.has(r.models.haiku)).toBe(true);
    expect(allowed.has(r.models.sonnet)).toBe(true);
    expect(allowed.has(r.models.fable)).toBe(true);
    expect(r.models.fable).not.toBe("claude-opus-4-8");
    // Сильной модели тариф не даёт вовсе → лестница схлопнута, и это ЧЕСТНО объявлено (панель предупредит).
    expect(r.collapsed).toBe(true);
    // Тариф с сильной моделью — сильный слот берёт именно её, слабый остаётся дешёвым.
    const withStrong = resolveTierModels(DEFAULTS, undefined, new Set(["claude-sonnet-5", "claude-opus-5"]));
    expect(withStrong.models.fable).toBe("claude-opus-5");
    expect(withStrong.models.sonnet).toBe("claude-sonnet-5");
    expect(withStrong.collapsed).toBe(false);
    // Без allowlist (дев-режим, флаг 0) — лестница НЕ трогается: поведение байт-в-байт прежнее.
    expect(resolveTierModels(DEFAULTS, undefined, null).models).toEqual(DEFAULTS);
  });

  it("одна модель в обоих слотах → collapsed (каскад §7 мёртв)", () => {
    const r = resolveTierModels(DEFAULTS, { primary: "claude-opus-5", strong: "claude-opus-5" });
    expect(r.collapsed).toBe(true);
  });

  it("downgrade: сильная модель дешевле основной → флаг (эскалация §7 ответ не усилит); иначе false", () => {
    expect(resolveTierModels(DEFAULTS, { primary: "claude-fable-5-1", strong: "claude-sonnet-5" }).downgrade).toBe(true);
    expect(resolveTierModels(DEFAULTS, { primary: "claude-sonnet-5", strong: "claude-opus-5" }).downgrade).toBe(false);
    expect(resolveTierModels(DEFAULTS, { primary: "claude-opus-5", strong: "claude-opus-5" }).downgrade).toBe(false);
  });
});

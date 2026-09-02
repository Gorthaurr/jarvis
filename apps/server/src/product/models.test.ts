import { afterAll, describe, expect, it, vi } from "vitest";

// Изолируем data-dir ДО импорта profile.ts (как в brain/profile.test.ts): сеттер персистит на диск.
const TMP = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  const dir = `${base}/jarvis-models-test-${process.pid}-${Date.now()}`;
  process.env.JARVIS_DATA_DIR = dir;
  return dir;
});

import { rmSync } from "node:fs";
import { MODEL_CATALOG, type TierModels } from "@jarvis/shared";
import { getProfile, loadProfile, setModelChoice } from "../brain/profile.js";
import { allowedSetFrom, buildModelsCatalog, effectiveModelsFor, modelChoiceFor, normalizeChoice } from "./models.js";

const DEFAULTS: TierModels = { haiku: "claude-sonnet-4-6", sonnet: "claude-sonnet-4-6", fable: "claude-opus-4-8" };

describe("product/models — выбор модели пользователем накладывается на лестницу тиров", () => {
  it("выбор применяется к слотам: primary → дефолт ходов, strong → эскалация; id нормализуются", () => {
    const c = buildModelsCatalog(DEFAULTS, { primary: "  Claude-Sonnet-5 ", strong: "claude-fable-5-1" }, null);
    expect(c.effective).toEqual({ primary: "claude-sonnet-5", strong: "claude-fable-5-1" });
    expect(c.chosen).toEqual({ primary: "claude-sonnet-5", strong: "claude-fable-5-1" });
    expect(c.rejected).toEqual([]);
    expect(c.allowed).toBeNull();
  });

  it("неизвестная модель ОТКЛОНЯЕТСЯ с причиной, слот остаётся дефолтным; второй слот применяется", () => {
    const c = buildModelsCatalog(DEFAULTS, { primary: "claude-nope-9", strong: "claude-fable-5-1" }, null);
    expect(c.rejected).toEqual([{ slot: "primary", id: "claude-nope-9", reason: "unknown" }]);
    expect(c.effective.primary).toBe(DEFAULTS.sonnet); // НЕ подставлено молча
    expect(c.effective.strong).toBe("claude-fable-5-1");
    // `chosen` честно показывает, что пользователь просил (иначе UI сбросил бы его выбор без объяснения).
    expect(c.chosen.primary).toBe("claude-nope-9");
  });

  it("модель вне allowlist плана → not_allowed, применяется РАЗРЕШЁННАЯ (не дефолт вне тарифа)", () => {
    const c = buildModelsCatalog(DEFAULTS, { primary: "claude-sonnet-5", strong: "claude-fable-5-1" }, ["claude-sonnet-5", " CLAUDE-OPUS-5 "]);
    expect(c.rejected).toEqual([{ slot: "strong", id: "claude-fable-5-1", reason: "not_allowed" }]);
    // Дефолтная сильная модель (Opus 4.8) тарифом не разрешена → берётся разрешённая Opus 5. Живой прогон
    // 2026-09-02: раньше оставался дефолт, и эскалация уходила на модель вне тарифа.
    expect(c.effective).toEqual({ primary: "claude-sonnet-5", strong: "claude-opus-5" });
    expect(c.allowed).toEqual(["claude-sonnet-5", "claude-opus-5"]); // нормализованный allowlist уходит в UI
  });

  it("allowedSetFrom: null = без ограничений, пустой список = пустое множество (не «любая»)", () => {
    expect(allowedSetFrom(null)).toBeNull();
    expect(allowedSetFrom(undefined)).toBeNull();
    const empty = allowedSetFrom([]);
    expect(empty?.size).toBe(0);
    // Пустой allowlist отклоняет любой явный выбор — дефолт лестницы при этом цел.
    const c = buildModelsCatalog(DEFAULTS, { primary: "claude-sonnet-5" }, []);
    expect(c.rejected[0]?.reason).toBe("not_allowed");
    expect(c.effective.primary).toBe(DEFAULTS.sonnet);
  });

  it("каталог содержит ВСЕ id из MODEL_CATALOG с подписью/семейством/ролью/классом стоимости", () => {
    const c = buildModelsCatalog(DEFAULTS, undefined, null);
    expect(c.catalog.map((m) => m.id)).toEqual(MODEL_CATALOG.map((m) => m.id));
    for (const m of MODEL_CATALOG) {
      const row = c.catalog.find((x) => x.id === m.id);
      expect(row).toEqual({ id: m.id, label: m.label, family: m.family, role: m.role, costClass: m.costClass });
    }
    expect(c.chosen).toEqual({}); // без выбора — «авто», без ложных полей
    expect(c.effective).toEqual({ primary: DEFAULTS.sonnet, strong: DEFAULTS.fable });
  });

  it("normalizeChoice: пробелы и регистр не считаются выбором", () => {
    expect(normalizeChoice({ primary: "   ", strong: "" })).toEqual({});
    expect(normalizeChoice(undefined)).toEqual({});
  });
});

describe("profile.setModelChoice — персист выбора и очистка пустых", () => {
  const U = "aaaaaaaa-0000-4000-8000-00000000c0de";

  afterAll(() => {
    try {
      rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("сохраняет непустые слоты, пустые не хранит, переживает перечитывание с диска", async () => {
    await loadProfile(U);
    await setModelChoice(U, { primary: " Claude-Sonnet-5 ", strong: "" });
    expect(getProfile(U).models).toEqual({ primary: "claude-sonnet-5" }); // strong не хранится как ""
    const reloaded = await loadProfile(U);
    expect(reloaded.models).toEqual({ primary: "claude-sonnet-5" });
    // Цепочка профиль → резолв: дефолт ходов (оба слота) стал выбранным, эскалация — дефолт.
    expect(modelChoiceFor(U)).toEqual({ primary: "claude-sonnet-5" });
    const r = effectiveModelsFor(DEFAULTS, U, null);
    expect(r.models).toEqual({ haiku: "claude-sonnet-5", sonnet: "claude-sonnet-5", fable: DEFAULTS.fable });
    expect(r.rejected).toEqual([]);
  });

  it("оба слота пустые → поле снимается целиком (профиль не хранит выбор, которого нет)", async () => {
    await setModelChoice(U, { primary: "", strong: "   " });
    expect(getProfile(U).models).toBeUndefined();
    expect((await loadProfile(U)).models).toBeUndefined(); // очистка персистится, не только в кеше
    expect(modelChoiceFor(U)).toEqual({});
    expect(effectiveModelsFor(DEFAULTS, U, null).models).toEqual(DEFAULTS);
  });

  it("allowlist плана применяется к выбору из профиля", async () => {
    await setModelChoice(U, { strong: "claude-fable-5-1" });
    const r = effectiveModelsFor(DEFAULTS, U, allowedSetFrom(["claude-opus-5"]));
    expect(r.rejected).toEqual([{ slot: "strong", id: "claude-fable-5-1", reason: "not_allowed" }]);
    // Отклонили выбор — но и дефолт вне тарифа не оставляем: работает разрешённая планом модель.
    expect(r.models.fable).toBe("claude-opus-5");
  });
});

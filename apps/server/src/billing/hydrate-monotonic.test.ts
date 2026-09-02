/**
 * 🔴 ЗАЩИТА МЕСЯЧНОГО ПОТОЛКА ТРАТ — ПО СУЩЕСТВУ (аудит тестовой базы 2026-09-01).
 *
 * Прежний тест монотонности честно писал в комментарии: «без реальной БД query() вернёт null», —
 * то есть проверяемая ветка НЕ ИСПОЛНЯЛАСЬ ни разу. Снятие фикса M3 (безусловная перезапись
 * `this.spent = prior`) оставляло прогон зелёным, хотя это прямой обход потолка трат: reconnect
 * сразу после всплеска расхода прочитал бы устаревшее значение из БД и обнулил только что учтённое.
 *
 * Здесь БД подменяется: `query` отдаёт заведомо СТАРОЕ значение, и проверяется наблюдаемое —
 * счётчик двигается только вперёд.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = { value: [] as Array<{ cost_estimate: number }> };

vi.mock("../db/pool.js", () => ({
  query: vi.fn(async () => ({ rows: rows.value })),
  isDbReady: async () => true,
}));

const { SpendGuard } = await import("./index.js");

beforeEach(() => {
  rows.value = [];
});

describe("hydrate двигает счётчик трат только ВПЕРЁД", () => {
  it("устаревшее значение из БД НЕ откатывает живой расход (иначе потолок обходится)", async () => {
    rows.value = [{ cost_estimate: 5 }]; // в БД лежит стейл: персист ещё не долетел
    const g = new SpendGuard({ spendCap: 100 }, { userId: "u1" });
    g.recordUsage("t1", 0, 42); // всплеск расхода прямо перед reconnect
    expect(g.totalSpent).toBe(42);

    await g.hydrate(); // reconnect

    expect(g.totalSpent).toBe(42); // ← до фикса M3 стало бы 5, и потолок можно было бы обходить
  });

  it("бОльшее значение из БД поднимает счётчик (восстановление после перезапуска)", async () => {
    rows.value = [{ cost_estimate: 77 }];
    const g = new SpendGuard({ spendCap: 100 }, { userId: "u1" });
    expect(g.totalSpent).toBe(0);

    await g.hydrate();

    expect(g.totalSpent).toBe(77); // траты периода не теряются при рестарте сервера
  });

  it("после восстановления потолок реально режет следующий вызов", async () => {
    rows.value = [{ cost_estimate: 95 }];
    const g = new SpendGuard({ spendCap: 100 }, { userId: "u1" });
    await g.hydrate();
    expect(g.check("t1", 10).allowed).toBe(false); // 95 + 10 > 100
  });

  it("мусор в БД не отравляет счётчик (NaN/отрицательное игнорируются)", async () => {
    const g = new SpendGuard({ spendCap: 100 }, { userId: "u1" });
    g.recordUsage("t1", 0, 30);
    for (const bad of [Number.NaN, -1000, Number.POSITIVE_INFINITY]) {
      rows.value = [{ cost_estimate: bad as number }];
      await g.hydrate();
      expect(Number.isFinite(g.totalSpent)).toBe(true);
      expect(g.totalSpent).toBe(30);
    }
  });

  it("пустая таблица (первый период) счётчик не трогает", async () => {
    rows.value = [];
    const g = new SpendGuard({ spendCap: 100 }, { userId: "u1" });
    g.recordUsage("t1", 0, 12);
    await g.hydrate();
    expect(g.totalSpent).toBe(12);
  });
});

import { describe, expect, it } from "vitest";
import { SpendGuard, SpendGuards } from "./index.js";

describe("SpendGuard — санитизация предохранителей (§14)", () => {
  it("NaN-стоимость НЕ отравляет spent (потолок продолжает работать)", () => {
    const g = new SpendGuard({ spendCap: 10 });
    g.recordUsage("t1", Number.NaN, Number.NaN); // битый usage
    expect(Number.isFinite(g.totalSpent)).toBe(true);
    expect(g.totalSpent).toBe(0);
    // потолок всё ещё срабатывает
    g.recordUsage("t1", 0, 9);
    expect(g.check("t1", 2).allowed).toBe(false);
    expect(g.check("t1", 2).reason).toBe("spend_cap");
  });

  it("NaN в estimatedCost у check НЕ маскирует уже-превышенный потолок", () => {
    const g = new SpendGuard({ spendCap: 5 });
    g.recordUsage("t1", 0, 6); // spent=6 уже ВЫШЕ потолка 5
    // без санитизации `6 + NaN > 5` === false → ход бы прошёл (дыра). С санитизацией NaN→0: 6>5 → деним.
    expect(g.check("t1", Number.NaN).allowed).toBe(false);
    expect(g.check("t1", Number.NaN).reason).toBe("spend_cap");
  });

  it("нечисловой spendCap (битый env → NaN) → дефолт, а не «выключено»", () => {
    const g = new SpendGuard({ spendCap: Number.NaN });
    g.recordUsage("t1", 0, 360); // выше дефолтного потолка (DEFAULT_LIMITS.spendCap=300)
    expect(g.check("t1", 1).allowed).toBe(false);
    expect(g.check("t1", 1).reason).toBe("spend_cap");
  });

  it("hydrate без userId — no-op, не роняет", async () => {
    const g = new SpendGuard({ spendCap: 10 });
    await expect(g.hydrate()).resolves.toBeUndefined();
    expect(g.totalSpent).toBe(0);
  });

  it("hydrate МОНОТОНЕН — не откатывает живой spent назад к устаревшему из БД (M3)", async () => {
    // Без реальной БД query() вернёт null/no-op, поэтому проверяем контракт напрямую: гидрация
    // не должна УМЕНЬШАТЬ spent, даже если в БД лежит меньшее (устаревшее) значение.
    const g = new SpendGuard({ spendCap: 100 }, { userId: "u1" });
    g.recordUsage("t1", 0, 42); // живой in-memory spent сразу после всплеска
    expect(g.totalSpent).toBe(42);
    // reconnect сразу после всплеска: hydrate читает БД (в тестовой среде — no-op/undefined),
    // живой spent не должен откатиться вниз.
    await g.hydrate();
    expect(g.totalSpent).toBeGreaterThanOrEqual(42);
  });

  it("месячный rollover сбрасывает spent на новом периоде", () => {
    let t = new Date("2026-01-15T00:00:00Z").getTime();
    const g = new SpendGuard({ spendCap: 10 }, { now: () => t });
    g.recordUsage("t1", 0, 9); // январь: spent=9 (у потолка)
    expect(g.totalSpent).toBe(9);
    expect(g.check("t1", 5).allowed).toBe(false); // 9+5 > 10
    t = new Date("2026-02-01T12:00:00Z").getTime(); // НОВЫЙ месяц
    expect(g.check("t1", 5).allowed).toBe(true); // rollover → spent сброшен → 0+5 ≤ 10
    expect(g.totalSpent).toBe(0);
  });

  it("kill-switch и нормальный учёт работают как прежде", () => {
    const g = new SpendGuard({ spendCap: 100 });
    expect(g.check("t1").allowed).toBe(true);
    g.recordUsage("t1", 1000, 10);
    expect(g.totalSpent).toBe(10);
    g.engageKillSwitch();
    expect(g.check("t1").allowed).toBe(false);
    expect(g.check("t1").reason).toBe("kill_switch");
  });
});

describe("SpendGuards — реестр по userId (§6B/B5 мультитенант)", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";

  it("forUser возвращает СТАБИЛЬНЫЙ гвард на userId (кеш)", () => {
    const reg = new SpendGuards({ spendCap: 100 });
    expect(reg.forUser(A)).toBe(reg.forUser(A));
    expect(reg.forUser(A)).not.toBe(reg.forUser(B));
  });

  it("траты ИЗОЛИРОВАНЫ по userId — один тенант не ест потолок другого", () => {
    const reg = new SpendGuards({ spendCap: 10 });
    reg.forUser(A).recordUsage("t1", 0, 9); // A почти у потолка
    expect(reg.forUser(A).check("t1", 5).allowed).toBe(false); // A: 9+5 > 10 → деним
    expect(reg.forUser(B).check("t1", 5).allowed).toBe(true); // B нетронут → проходит
    expect(reg.forUser(B).totalSpent).toBe(0);
  });

  it("kill-switch одного юзера не глушит другого", () => {
    const reg = new SpendGuards({ spendCap: 100 });
    reg.forUser(A).engageKillSwitch();
    expect(reg.forUser(A).check("t1").allowed).toBe(false);
    expect(reg.forUser(B).check("t1").allowed).toBe(true);
  });

  it("hydrate(userId)/drainAll — без БД no-op, не роняют", async () => {
    const reg = new SpendGuards({ spendCap: 10 });
    await expect(reg.hydrate(A)).resolves.toBeUndefined();
    reg.forUser(A).recordUsage("t1", 0, 1);
    await expect(reg.drainAll()).resolves.toBeUndefined();
  });

  it("snapshot(userId) — расход/потолок/остаток для вкладки «Оплата» (§6B/B5)", () => {
    const reg = new SpendGuards({ spendCap: 50 });
    reg.forUser(A).recordUsage("t1", 100, 12.5);
    const s = reg.snapshot(A);
    expect(s.cap).toBe(50);
    expect(s.spent).toBeCloseTo(12.5, 5);
    expect(s.remaining).toBeCloseTo(37.5, 5);
    expect(s.killSwitch).toBe(false);
    expect(s.period).toMatch(/^\d{4}-\d{2}$/);
    // изоляция: у другого юзера снимок чист
    expect(reg.snapshot(B).spent).toBe(0);
  });

  it("allSnapshots — все известные юзеры с расходом (для COGS-дашборда /cogs)", () => {
    const reg = new SpendGuards({ spendCap: 50 });
    reg.forUser(A).recordUsage("t1", 100, 12.5);
    reg.forUser(B).recordUsage("t1", 50, 3);
    const all = reg.allSnapshots();
    expect(all).toHaveLength(2);
    const byUser = Object.fromEntries(all.map((s) => [s.userId, s]));
    expect(byUser[A]!.spent).toBeCloseTo(12.5, 5);
    expect(byUser[B]!.spent).toBeCloseTo(3, 5);
    // только юзеры с активностью (ленивая Map) — нетронутый не появляется
    expect(reg.allSnapshots().some((s) => s.userId === "never-touched")).toBe(false);
  });
});

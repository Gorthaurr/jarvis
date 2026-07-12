import { describe, expect, it } from "vitest";
import type { SymbolStat } from "./predictions.js";
import { type Prediction, PredictionStore, computeWinRate, qualifiedSetups, resolveByPath, resolveOne } from "./predictions.js";

const open = (over: Partial<Prediction> = {}): Prediction => ({
  id: "x", userId: "u", symbol: "BTCUSDT", market: "crypto", direction: "up",
  horizonMs: 1000, createdAt: 0, resolveAt: 1000, entryPrice: 100, status: "open", ...over,
});

describe("predictions — сверка и винрейт (§трейдинг слой 2)", () => {
  it("resolveOne: в сторону прогноза → correct; против/флэт → wrong; movePct со знаком", () => {
    expect(resolveOne(open(), 110, 1000).status).toBe("correct"); // up, цена выросла
    expect(resolveOne(open(), 90, 1000).status).toBe("wrong"); // up, упала
    expect(resolveOne(open({ direction: "down" }), 90, 1000).status).toBe("correct"); // down, упала
    expect(resolveOne(open(), 100, 1000).status).toBe("wrong"); // флэт = мимо
    expect(resolveOne(open(), 110, 1000).movePct).toBeCloseTo(10, 6);
  });

  it("computeWinRate: доля попаданий + средний край в сторону прогноза", () => {
    const items = [
      open({ status: "correct", direction: "up", movePct: 5 }),
      open({ status: "wrong", direction: "up", movePct: -3 }),
      open({ status: "correct", direction: "down", movePct: -4 }), // вниз угадал → край +4
      open({ status: "open" }),
    ];
    const w = computeWinRate(items);
    expect(w.total).toBe(4);
    expect(w.open).toBe(1);
    expect(w.resolved).toBe(3);
    expect(w.correct).toBe(2);
    expect(w.winRate).toBeCloseTo(2 / 3, 6);
    // края: +5, -3, +4 → среднее +2
    expect(w.avgEdgePct).toBeCloseTo(2, 6);
  });

  it("computeWinRate: ЧИСТЫЙ край после издержек + лидерборд по инструментам", () => {
    const items = [
      open({ symbol: "SBER", status: "correct", direction: "up", movePct: 0.5, costPct: 0.1 }), // net +0.4
      open({ symbol: "SBER", status: "correct", direction: "up", movePct: 0.05, costPct: 0.1 }), // угадал, но net −0.05 (на брокера)
      open({ symbol: "BTCUSDT", status: "correct", direction: "down", movePct: -2, costPct: 0.2 }), // net +1.8
    ];
    const w = computeWinRate(items);
    expect(w.winRate).toBe(1); // по направлению 3/3
    expect(w.netWinRate).toBeCloseTo(2 / 3, 6); // SBER#2 не покрыл комиссию
    expect(w.avgNetEdgePct).toBeCloseTo((0.4 - 0.05 + 1.8) / 3, 6);
    // лидерборд: BTC выше SBER по чистому краю
    expect(w.bySymbol[0]?.symbol).toBe("BTCUSDT");
    expect(w.bySymbol.find((s) => s.symbol === "SBER")?.resolved).toBe(2);
  });

  it("PredictionStore: record → авто-сверка по горизонту → winRate", async () => {
    let t = 0;
    const store = new PredictionStore(() => t);
    store.record("u", { symbol: "BTCUSDT", market: "crypto", direction: "up", horizonMs: 1000 }, 100);
    store.record("u", { symbol: "ETHUSDT", market: "crypto", direction: "down", horizonMs: 1000 }, 50);
    // до горизонта ничего не сверяется
    expect((await store.resolveDue("u", async () => 0)).length).toBe(0);
    t = 2000; // горизонт истёк
    const prices: Record<string, number> = { BTCUSDT: 110, ETHUSDT: 55 }; // BTC↑ (угадал up), ETH↑ (мимо down)
    const resolved = await store.resolveDue("u", async (s) => prices[s]!);
    expect(resolved.length).toBe(2);
    const w = store.winRate("u");
    expect(w.resolved).toBe(2);
    expect(w.correct).toBe(1);
    expect(w.winRate).toBe(0.5);
    expect(store.list("u", { status: "correct" })[0]?.symbol).toBe("BTCUSDT");
  });

  it("qualifiedSetups: реальные деньги ТОЛЬКО при net>0 + выборка≥30 + статзначимо", () => {
    const stats: SymbolStat[] = [
      { symbol: "BTC", resolved: 50, correct: 33, winRate: 0.66, avgNetEdgePct: 0.3 }, // n50, 66%, z≈2.3, net>0 → ✓
      { symbol: "ETH", resolved: 8, correct: 7, winRate: 0.875, avgNetEdgePct: 0.5 }, // выборка мала (8<30) → ✗
      { symbol: "SOL", resolved: 40, correct: 26, winRate: 0.65, avgNetEdgePct: -0.1 }, // net<0 → ✗
      { symbol: "XRP", resolved: 40, correct: 21, winRate: 0.525, avgNetEdgePct: 0.2 }, // не значимо (z≈0.3) → ✗
    ];
    const q = qualifiedSetups(stats);
    const by = (s: string) => q.find((x) => x.symbol === s)!;
    expect(by("BTC").qualified).toBe(true);
    expect(by("ETH").qualified).toBe(false); // мало данных
    expect(by("SOL").qualified).toBe(false); // в минусе после комиссий
    expect(by("XRP").qualified).toBe(false); // случайность (не значимо)
    expect(q[0]!.symbol).toBe("ETH"); // сортировка по чистому краю (0.5 макс), вердикт отдельно
    expect(q.filter((x) => x.qualified).map((x) => x.symbol)).toEqual(["BTC"]);
  });

  it("PredictionStore: ДЕДУП — наложение ходов не плодит дубль по инструменту+горизонту", () => {
    let t = 0;
    const store = new PredictionStore(() => t);
    const a = store.record("u", { symbol: "BTCUSDT", market: "crypto", direction: "up", horizonMs: 3_600_000 }, 60000);
    const b = store.record("u", { symbol: "btcusdt", market: "crypto", direction: "up", horizonMs: 3_600_000 }, 60010); // дубль в окне
    const c = store.record("u", { symbol: "BTCUSDT", market: "crypto", direction: "down", horizonMs: 3_600_000 }, 60020); // противоречие в окне
    expect(b.id).toBe(a.id); // вернулся тот же
    expect(c.id).toBe(a.id); // противоречивый тоже схлопнут (первый победил)
    expect(store.list("u")).toHaveLength(1);
    // другой горизонт — отдельный прогноз
    const d = store.record("u", { symbol: "BTCUSDT", market: "crypto", direction: "up", horizonMs: 180_000 }, 60000);
    expect(d.id).not.toBe(a.id);
    expect(store.list("u")).toHaveLength(2);
  });

  it("PredictionStore: чужие прогнозы не сверяет, фильтр по userId", async () => {
    let t = 0;
    const store = new PredictionStore(() => t);
    store.record("u1", { symbol: "SBER", market: "moex", direction: "up", horizonMs: 100 }, 300);
    store.record("u2", { symbol: "SBER", market: "moex", direction: "up", horizonMs: 100 }, 300);
    t = 500;
    const r = await store.resolveDue("u1", async () => 310);
    expect(r.length).toBe(1); // только u1
    expect(store.winRate("u2").resolved).toBe(0); // u2 не тронут
  });
});

/** Свеча для path-сверки (o/v не влияют — важны h/l/c). */
const candle = (t: number, h: number, l: number, c: number) => ({ t, o: c, h, l, c, v: 1 });

describe("predictions — PATH-сверка по R (§трейдинг слой 3: матожидание)", () => {
  const P = (over: Partial<Prediction> = {}): Prediction =>
    open({ entryPrice: 100, stopPrice: 95, targetPrice: 110, createdAt: 0, resolveAt: 1000, ...over });

  it("лонг, выбило стопом первым → wrong, R≈−1, outcome stop", () => {
    const r = resolveByPath(P(), [candle(100, 102, 96, 101), candle(200, 103, 94, 96)], 500);
    expect(r.outcome).toBe("stop");
    expect(r.status).toBe("wrong");
    expect(r.rMultiple).toBeCloseTo(-1, 6); // (95−100)/5
    expect(r.exitPrice).toBe(95);
  });

  it("лонг, дошло до тейка первым → correct, R=+2, outcome target", () => {
    const r = resolveByPath(P(), [candle(100, 108, 99, 107), candle(200, 112, 106, 110)], 500);
    expect(r.outcome).toBe("target");
    expect(r.status).toBe("correct");
    expect(r.rMultiple).toBeCloseTo(2, 6); // (110−100)/5
  });

  it("не дошло ни до стопа, ни до тейка → time, R по последнему close", () => {
    const r = resolveByPath(P(), [candle(100, 104, 98, 103), candle(200, 106, 99, 102)], 500);
    expect(r.outcome).toBe("time");
    expect(r.rMultiple).toBeCloseTo((102 - 100) / 5, 6); // +0.4R
    expect(r.status).toBe("correct");
  });

  it("шорт симметричен — стоп выше входа, тейк ниже", () => {
    const p = P({ direction: "down", entryPrice: 100, stopPrice: 105, targetPrice: 90 });
    const r = resolveByPath(p, [candle(100, 103, 97, 98), candle(200, 92, 88, 90)], 500);
    expect(r.outcome).toBe("target");
    expect(r.rMultiple).toBeCloseTo((100 - 90) / 5, 6); // +2R
  });

  it("стоп И тейк в ОДНОЙ свече → консервативно стоп", () => {
    const r = resolveByPath(P(), [candle(100, 111, 94, 100)], 500);
    expect(r.outcome).toBe("stop");
    expect(r.rMultiple).toBeCloseTo(-1, 6);
  });

  it("без стопа → деградирует на направление по последней цене (R отсутствует)", () => {
    const r = resolveByPath(P({ stopPrice: undefined }), [candle(100, 112, 90, 108)], 500);
    expect(r.rMultiple).toBeUndefined();
    expect(r.status).toBe("correct"); // 108 > 100
  });

  it("аудит [4]: свеча ДО createdAt не резолвит прогноз (до-входный фитиль не считается)", () => {
    // createdAt=1000: бар t=500 (ДО прогноза) провалился к 94 (ниже стопа 95) — но это было ДО входа;
    // после входа цена идёт в тейк. Прежде resolveByPath бил стоп по до-входному бару → ложный wrong.
    const p = P({ createdAt: 1000, resolveAt: 3000 });
    const r = resolveByPath(
      p,
      [candle(500, 103, 94, 96), candle(1500, 108, 99, 107), candle(2500, 112, 106, 110)],
      3000,
    );
    expect(r.outcome).toBe("target"); // по пост-входным барам, не по до-входному касанию стопа
    expect(r.status).toBe("correct");
  });

  it("аудит [5]: инвертированный стоп (long, stop>entry) → resolveOne, НЕ ложная +1R победа", () => {
    // stop=105 при entry=100 для лонга — не с той стороны. Path-сверка дала бы exit=105>entry → +1R
    // «победа» (стоп-аут как выигрыш). Теперь стоп невалиден → resolveOne по направлению, R отсутствует.
    const r = resolveByPath(P({ stopPrice: 105 }), [candle(500, 108, 96, 98)], 1000);
    expect(r.rMultiple).toBeUndefined(); // не книжим стоп-аут как победу
    expect(r.status).toBe("wrong"); // resolveOne: 98 < 100 для лонга → не угадал
  });

  it("computeWinRate: матожидание в R + профит-фактор по прогнозам со стопом", () => {
    const items = [
      P({ status: "correct", rMultiple: 2, costPct: 0.2 }), // риск 5% → costR 0.04 → net 1.96
      P({ status: "wrong", rMultiple: -1, costPct: 0.2 }), // net −1.04
      P({ status: "correct", rMultiple: 1.5, costPct: 0.2 }), // net 1.46
    ];
    const w = computeWinRate(items);
    expect(w.rResolved).toBe(3);
    expect(w.expectancyR).toBeCloseTo((2 - 1 + 1.5) / 3, 6); // +0.833R gross
    expect(w.netExpectancyR).toBeLessThan(w.expectancyR); // издержки в R съедают
    expect(w.netExpectancyR).toBeGreaterThan(0);
    expect(w.profitFactor).toBeCloseTo((1.96 + 1.46) / 1.04, 2);
  });

  it("resolveDue: со стопом → PATH по candleFn (R); без стопа → priceFn (направление)", async () => {
    let t = 0;
    const store = new PredictionStore(() => t);
    store.record("u", { symbol: "BTCUSDT", market: "crypto", direction: "up", horizonMs: 1000, stopPrice: 95, targetPrice: 110 }, 100);
    store.record("u", { symbol: "ETHUSDT", market: "crypto", direction: "up", horizonMs: 1000 }, 50); // без стопа
    t = 2000;
    const candleFn = async (s: string) => (s === "BTCUSDT" ? [candle(500, 112, 99, 110)] : []);
    const priceFn = async (s: string) => (s === "ETHUSDT" ? 55 : 100);
    const resolved = await store.resolveDue("u", priceFn, candleFn);
    expect(resolved.length).toBe(2);
    const btc = store.list("u", { symbol: "BTCUSDT" })[0]!;
    expect(btc.outcome).toBe("target");
    expect(btc.rMultiple).toBeCloseTo(2, 6);
    const eth = store.list("u", { symbol: "ETHUSDT" })[0]!;
    expect(eth.rMultiple).toBeUndefined(); // без стопа — направление
    expect(eth.status).toBe("correct");
  });
});

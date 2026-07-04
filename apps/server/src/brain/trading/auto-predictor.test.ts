import { describe, expect, it } from "vitest";
import type { BaseRateResult } from "./backtest.js";
import { type SetupSignal, alignsWithHigherTrend, autoPredictorConfigFromEnv, decideFromBaseRate, decideSetup } from "./auto-predictor.js";

describe("alignsWithHigherTrend — фильтр старшего тренда (фикс «всё шорты в растущем рынке»)", () => {
  it("блокирует прогноз ПРОТИВ старшего тренда, пропускает по тренду и в range", () => {
    expect(alignsWithHigherTrend("up", "up")).toBe(true);
    expect(alignsWithHigherTrend("down", "up")).toBe(false); // шорт против восходящего старшего — БЛОК (это и был баг)
    expect(alignsWithHigherTrend("up", "down")).toBe(false); // лонг против нисходящего — блок
    expect(alignsWithHigherTrend("down", "down")).toBe(true);
    expect(alignsWithHigherTrend("up", "range")).toBe(true); // range не мешает
    expect(alignsWithHigherTrend("down", "range")).toBe(true);
  });
});

describe("auto-predictor — решение по перевесу (§трейдинг: только где есть статистика)", () => {
  const cfg = { minSamples: 25, minUpRate: 0.55 };

  it("перевес вверх (≥0.55, выборка ок) → up", () => {
    expect(decideFromBaseRate({ upRate: 0.6, samples: 100, combo: null }, cfg)?.direction).toBe("up");
  });

  it("перевес вниз (≤0.45) → down", () => {
    expect(decideFromBaseRate({ upRate: 0.4, samples: 100, combo: null }, cfg)?.direction).toBe("down");
  });

  it("около 50/50 → null (края нет, не гадаем)", () => {
    expect(decideFromBaseRate({ upRate: 0.52, samples: 100, combo: null }, cfg)).toBeNull();
    expect(decideFromBaseRate({ upRate: 0.48, samples: 100, combo: null }, cfg)).toBeNull();
  });

  it("мало выборки → null (нет статистики)", () => {
    expect(decideFromBaseRate({ upRate: 0.8, samples: 10, combo: null }, cfg)).toBeNull();
  });

  it("предпочитает СВЯЗКУ при достаточной её выборке (combo важнее rsi-only)", () => {
    // rsi-only говорит up (0.6), но связка (выборка ок) говорит down (0.4) → берём связку → down
    const d = decideFromBaseRate({ upRate: 0.6, samples: 100, combo: { upRate: 0.4, samples: 50 } }, cfg);
    expect(d?.direction).toBe("down");
  });

  it("связка с малой выборкой игнорируется → падаем на rsi-only", () => {
    const d = decideFromBaseRate({ upRate: 0.6, samples: 100, combo: { upRate: 0.4, samples: 5 } }, cfg);
    expect(d?.direction).toBe("up"); // combo не дотянул выборку → rsi-only (up)
  });

  it("ТРЕНДОВЫЙ ФИЛЬТР: апсайд-сигнал в НИСХОДЯЩЕМ тренде → null (не покупаем против тренда)", () => {
    expect(decideFromBaseRate({ upRate: 0.6, samples: 100, trendUp: false, combo: null }, cfg)).toBeNull();
  });

  it("ТРЕНДОВЫЙ ФИЛЬТР: даунсайд-сигнал в ВОСХОДЯЩЕМ тренде → null (не шортим против тренда, фикс 18%)", () => {
    expect(decideFromBaseRate({ upRate: 0.4, samples: 100, trendUp: true, combo: null }, cfg)).toBeNull();
  });

  it("ПО ТРЕНДУ проходит: апсайд + восходящий → up; даунсайд + нисходящий → down", () => {
    expect(decideFromBaseRate({ upRate: 0.6, samples: 100, trendUp: true, combo: null }, cfg)?.direction).toBe("up");
    expect(decideFromBaseRate({ upRate: 0.4, samples: 100, trendUp: false, combo: null }, cfg)?.direction).toBe("down");
  });
});

describe("auto-predictor — КОНФЛЮЭНС-сетап decideSetup (price action, не один RSI)", () => {
  const cfg = { minSamples: 25, minUpRate: 0.55, minScore: 2, levelPct: 0.015 };
  const br = (over: Partial<BaseRateResult> = {}): BaseRateResult => ({
    bars: 500, horizonBars: 1, currentRsi: 50, bucket: "x", samples: 100, upRate: 0.6,
    avgReturnPct: 0, baselineUpRate: 0.5, baselineAvgPct: 0, edgePp: 10, trendUp: true, ...over,
  });
  const sig = (over: Partial<SetupSignal> = {}): SetupSignal => ({
    symbol: "X", market: "crypto", interval: "1h", price: 100,
    structure: { trend: "up", support: 99, resistance: 105, desc: "" },
    patterns: [], relVolume: 1, baseRate: br(), ...over,
  });

  it("полный лонг-сетап (тренд↑ + база↑ + бычье поглощение + у поддержки) → up", () => {
    const d = decideSetup(sig({ patterns: [{ name: "бычье поглощение", bias: "bull" }] }), cfg);
    expect(d?.direction).toBe("up");
    expect(d?.reason).toMatch(/поддержк/);
  });

  it("свечной паттерн ПРОТИВ направления → отмена (тренд↑, но медвежья свеча)", () => {
    expect(decideSetup(sig({ patterns: [{ name: "медвежье поглощение", bias: "bear" }] }), cfg)).toBeNull();
  });

  it("середина диапазона (не у уровня) → пропуск", () => {
    expect(decideSetup(sig({ structure: { trend: "range", support: 90, resistance: 110, desc: "" } }), cfg)).toBeNull();
  });

  it("диапазон у поддержки + бычья свеча → up (range-bounce, без тренда)", () => {
    const d = decideSetup(sig({ structure: { trend: "range", support: 99, resistance: 110, desc: "" }, baseRate: null, patterns: [{ name: "молот", bias: "bull" }] }), cfg);
    expect(d?.direction).toBe("up"); // у поддержки(+1) + свеча(+1) = 2
  });

  it("даунтренд + база↓ + медвежья свеча + у сопротивления → down", () => {
    const d = decideSetup(sig({ price: 100, structure: { trend: "down", support: 95, resistance: 101, desc: "" }, baseRate: br({ upRate: 0.4 }), patterns: [{ name: "падающая звезда", bias: "bear" }] }), cfg);
    expect(d?.direction).toBe("down");
  });

  it("слишком мало факторов (<minScore) → пропуск", () => {
    // только база↑ (1), без паттерна и не у поддержки (цена далеко) → score 1 < 2
    expect(decideSetup(sig({ price: 100, structure: { trend: "up", support: 90, resistance: 120, desc: "" } }), cfg)).toBeNull();
  });
});

describe("autoPredictorConfigFromEnv — раздельные ТФ крипты/МосБиржи + длинные горизонты", () => {
  const keys = ["JARVIS_AUTO_PREDICT", "JARVIS_AUTO_PREDICT_SYMBOLS", "JARVIS_AUTO_PREDICT_TFS", "JARVIS_AUTO_PREDICT_MOEX_SYMBOLS", "JARVIS_AUTO_PREDICT_MOEX_TFS"];
  const clean = () => keys.forEach((k) => delete process.env[k]);

  it("крипта по своим ТФ (4h,1d), МосБиржа только 1d", () => {
    clean();
    process.env.JARVIS_AUTO_PREDICT = "1";
    process.env.JARVIS_AUTO_PREDICT_SYMBOLS = "BTCUSDT";
    process.env.JARVIS_AUTO_PREDICT_TFS = "4h,1d";
    process.env.JARVIS_AUTO_PREDICT_MOEX_SYMBOLS = "SBER";
    process.env.JARVIS_AUTO_PREDICT_MOEX_TFS = "1d";
    process.env.JARVIS_AUTO_PREDICT_FUT_SYMBOLS = "BTCUSDT";
    const cfg = autoPredictorConfigFromEnv("u1");
    expect(cfg).not.toBeNull();
    expect(cfg!.watch.filter((x) => x.market === "crypto").map((x) => x.tf)).toEqual(["4h", "1d"]);
    expect(cfg!.watch.filter((x) => x.market === "tinkoff").map((x) => x.tf)).toEqual(["1d"]);
    expect(cfg!.watch.filter((x) => x.market === "crypto_fut").map((x) => x.tf)).toEqual(["4h", "1d"]); // перпы по крипто-ТФ
    delete process.env.JARVIS_AUTO_PREDICT_FUT_SYMBOLS;
    clean();
  });

  it("без флага JARVIS_AUTO_PREDICT → null (выключен)", () => {
    clean();
    expect(autoPredictorConfigFromEnv("u1")).toBeNull();
  });

  it("дефолтные горизонты крипты — длинные (4h,1d), не интрадей", () => {
    clean();
    process.env.JARVIS_AUTO_PREDICT = "1";
    const cfg = autoPredictorConfigFromEnv("u1");
    expect(cfg!.watch.filter((x) => x.market === "crypto").map((x) => x.tf)).toContain("4h");
    expect(cfg!.watch.filter((x) => x.market === "crypto").map((x) => x.tf)).toContain("1d");
    expect(cfg!.watch.filter((x) => x.market === "crypto").map((x) => x.tf)).not.toContain("15m");
    clean();
  });
});

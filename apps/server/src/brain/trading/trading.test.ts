import { describe, expect, it } from "vitest";
import { type Candle, MockMarketDataProvider, PredictionStore, type Quote, TradingService, inferMarket } from "./index.js";
import { moexDate, parseBinanceCandles, parseIssTable, parseMoexCandles, parseMoexQuote } from "./market.js";

describe("market parsers — чистые, без сети (§трейдинг)", () => {
  it("parseIssTable: {columns,data} → массив объектов по колонкам", () => {
    const json = { marketdata: { columns: ["SECID", "LAST"], data: [["SBER", 250.5]] } };
    expect(parseIssTable(json, "marketdata")).toEqual([{ SECID: "SBER", LAST: 250.5 }]);
    expect(parseIssTable({}, "marketdata")).toEqual([]);
  });

  it("parseMoexQuote: берёт LAST, фолбэк на PREVPRICE до открытия торгов", () => {
    const live = { marketdata: { columns: ["LAST", "VOLTODAY"], data: [[250.5, 1000]] }, securities: { columns: ["CURRENCYID"], data: [["RUB"]] } };
    const q = parseMoexQuote(live, "sber");
    expect(q?.last).toBe(250.5);
    expect(q?.symbol).toBe("SBER");
    expect(q?.market).toBe("moex");
    // до торгов LAST пуст → PREVPRICE
    const pre = { marketdata: { columns: ["LAST"], data: [[null]] }, securities: { columns: ["PREVPRICE"], data: [[248]] } };
    expect(parseMoexQuote(pre, "sber")?.last).toBe(248);
    // совсем нет данных → null (честно, не выдумываем)
    expect(parseMoexQuote({}, "sber")).toBeNull();
  });

  it("parseMoexCandles / parseBinanceCandles → OHLCV", () => {
    const moex = { candles: { columns: ["open", "close", "high", "low", "value", "volume", "begin"], data: [[100, 105, 106, 99, 0, 5000, "2024-01-10 10:00:00"]] } };
    const mc = parseMoexCandles(moex);
    expect(mc).toHaveLength(1);
    expect(mc[0]).toMatchObject({ o: 100, c: 105, h: 106, l: 99, v: 5000 });
    expect(Number.isFinite(mc[0]!.t)).toBe(true);

    const bin = [[1700000000000, "42000.0", "42500.0", "41800.0", "42300.0", "12.5"]];
    const bc = parseBinanceCandles(bin);
    expect(bc[0]).toEqual({ t: 1700000000000, o: 42000, h: 42500, l: 41800, c: 42300, v: 12.5 });
    expect(parseBinanceCandles({})).toEqual([]);
  });

  it("MOEX-время трактуется как МСК (UTC+3): begin «10:00 MSK» = 07:00 UTC", () => {
    // ISS begin — московское wall-clock. «2024-01-10 10:00:00» МСК = 2024-01-10T07:00:00Z (UTC).
    const moex = { candles: { columns: ["open", "close", "high", "low", "value", "volume", "begin"], data: [[100, 105, 106, 99, 0, 5000, "2024-01-10 10:00:00"]] } };
    const mc = parseMoexCandles(moex);
    expect(mc[0]!.t).toBe(Date.parse("2024-01-10T07:00:00Z"));
  });

  it("moexDate: UTC-инстант → МСК wall-clock (07:00 UTC → «10:00» строкой)", () => {
    // Обратное преобразование для from/till: тот же 07:00 UTC должен уйти в ISS как 10:00 МСК.
    expect(moexDate(Date.parse("2024-01-10T07:00:00Z"))).toBe("2024-01-10 10:00:00");
  });

  it("round-trip moexDate↔parseMoexCandles на известном UTC-инстанте не сдвигает время", () => {
    const utc = Date.parse("2024-06-15T12:30:00Z");
    const begin = moexDate(utc); // UTC → строка МСК, как ISS ждёт в from/till
    const moex = { candles: { columns: ["open", "close", "high", "low", "value", "volume", "begin"], data: [[1, 1, 1, 1, 0, 1, begin]] } };
    expect(parseMoexCandles(moex)[0]!.t).toBe(utc); // строка МСК → тот же UTC-инстант
  });
});

describe("inferMarket — вывод площадки из тикера", () => {
  it("крипто-пары → crypto, иначе moex; явная площадка приоритетна", () => {
    expect(inferMarket("BTCUSDT")).toBe("crypto");
    expect(inferMarket("ETHUSDT")).toBe("crypto");
    expect(inferMarket("SBER")).toBe("moex");
    expect(inferMarket("GAZP")).toBe("moex");
    expect(inferMarket("SBER", "crypto")).toBe("crypto"); // явная важнее
  });
});

describe("TradingService.analyze — котировка + индикаторы + сводка (мок-данные)", () => {
  it("собирает индикаторы и фактическую сводку (без совета)", async () => {
    const quote: Quote = { symbol: "SBER", market: "moex", last: 160, changePct: 1.2, ts: 0 };
    // 60 растущих свечей → хватит на SMA50/RSI/MACD/ATR
    const candles: Candle[] = Array.from({ length: 60 }, (_, i) => ({ t: i, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1000 }));
    const svc = new TradingService(new MockMarketDataProvider(quote, candles));
    const a = await svc.analyze("SBER");
    expect(a.quote.last).toBe(160);
    expect(a.bars).toBe(60);
    expect(a.indicators.sma50).not.toBeNull();
    expect(a.indicators.rsi14).toBe(100); // строго растущий ряд
    expect(a.summary.join(" ")).toMatch(/RSI/);
    expect(a.summary.join(" ")).toMatch(/восходящий/); // цена выше SMA50
  });
});

describe("TradingService — прогнозы (фиксация входа, сверка, винрейт)", () => {
  it("predict фиксирует цену входа из котировки; resolve+winRate через сервис", async () => {
    let t = 0;
    const store = new PredictionStore(() => t);
    const data = new MockMarketDataProvider({ symbol: "BTCUSDT", market: "crypto", last: 100, ts: 0 }, []);
    const svc = new TradingService(data, store);
    const p = await svc.predict("u", { symbol: "BTCUSDT", market: "crypto", direction: "up", horizonMs: 1000 });
    expect(p.entryPrice).toBe(100);
    expect(p.status).toBe("open");
    t = 2000; // горизонт истёк; мок отдаёт ту же цену 100 → флэт → мимо
    const w = await svc.winRate("u");
    expect(w.resolved).toBe(1);
    expect(w.correct).toBe(0);
  });

  it("без журнала: winRate бросает, list пуст (честно)", async () => {
    const svc = new TradingService(new MockMarketDataProvider());
    await expect(svc.winRate("u")).rejects.toThrow();
    expect(await svc.listPredictions("u")).toEqual([]);
  });

  it("openPredictionExists: не плодим дубль открытого прогноза (фикс «7× DOGE-шорт»)", () => {
    const store = new PredictionStore(() => 0);
    const svc = new TradingService(new MockMarketDataProvider(), store);
    store.record("u", { symbol: "DOGEUSDT", market: "crypto", direction: "down", horizonMs: 3_600_000 }, 0.075);
    expect(svc.openPredictionExists("u", "DOGEUSDT", "crypto", 3_600_000)).toBe(true); // тот же сетап ещё открыт
    expect(svc.openPredictionExists("u", "DOGEUSDT", "crypto", 14_400_000)).toBe(false); // другой горизонт — можно
    expect(svc.openPredictionExists("u", "BTCUSDT", "crypto", 3_600_000)).toBe(false); // другой инструмент — можно
    expect(svc.openPredictionExists("u", "DOGEUSDT", "crypto_fut", 3_600_000)).toBe(false); // другая площадка — можно
  });
});

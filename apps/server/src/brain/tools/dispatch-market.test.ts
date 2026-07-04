import { describe, expect, it } from "vitest";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { type Candle, MockMarketDataProvider, PredictionStore, type Quote, TradingService } from "../trading/index.js";

function ctxWith(market?: TradingService): ToolContext {
  return { session: { sendAction: async () => ({ commandId: "c", ok: true, durationMs: 1 }) }, userId: "u1", market } as unknown as ToolContext;
}

const quote: Quote = { symbol: "SBER", market: "moex", last: 250.5, changePct: 1.2, volume: 1000, currency: "RUB", ts: 0 };
const candles: Candle[] = Array.from({ length: 60 }, (_, i) => ({ t: i, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1000 }));

describe("market_* через dispatch (§трейдинг, только чтение)", () => {
  it("market_quote: форматирует котировку", async () => {
    const r = await dispatchTool("market_quote", { symbol: "SBER" }, ctxWith(new TradingService(new MockMarketDataProvider(quote, candles))));
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toMatch(/SBER/);
    expect(String(r.content)).toMatch(/250\.5/);
  });

  it("market_analyze: индикаторы + дисклеймер «не инвестиционный совет»", async () => {
    const r = await dispatchTool("market_analyze", { symbol: "SBER" }, ctxWith(new TradingService(new MockMarketDataProvider(quote, candles))));
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toMatch(/RSI14/);
    expect(String(r.content)).toMatch(/не инвестиционный совет/i);
  });

  it("нет ctx.market → честная ошибка (не выдумывает цену)", async () => {
    const r = await dispatchTool("market_quote", { symbol: "SBER" }, ctxWith(undefined));
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/недоступн/i);
  });

  it("пустой symbol → честная ошибка", async () => {
    const r = await dispatchTool("market_quote", {}, ctxWith(new TradingService(new MockMarketDataProvider(quote, candles))));
    expect(r.isError).toBe(true);
  });

  it("источник кинул (нет данных) → честная ошибка, не молчит", async () => {
    const r = await dispatchTool("market_quote", { symbol: "НЕТ" }, ctxWith(new TradingService(new MockMarketDataProvider(null, []))));
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/не удалось/i);
  });
});

describe("trade_predict / trade_winrate через dispatch (§трейдинг слой 2)", () => {
  const svc = () => new TradingService(new MockMarketDataProvider(quote, candles), new PredictionStore(() => 0));

  it("trade_predict: записывает прогноз (вход из котировки), помечает «не сделка»", async () => {
    const r = await dispatchTool("trade_predict", { symbol: "SBER", direction: "up", horizon: "1h" }, ctxWith(svc()));
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toMatch(/Прогноз записан/);
    expect(String(r.content)).toMatch(/не сделка/i);
  });

  it("trade_predict: кривой horizon → честная ошибка", async () => {
    const r = await dispatchTool("trade_predict", { symbol: "SBER", direction: "up", horizon: "завтра" }, ctxWith(svc()));
    expect(r.isError).toBe(true);
  });

  it("trade_winrate: пока нет разрешённых → честно про открытые, без выдуманного винрейта", async () => {
    const s = svc();
    await dispatchTool("trade_predict", { symbol: "SBER", direction: "up", horizon: "1d" }, ctxWith(s));
    const r = await dispatchTool("trade_winrate", {}, ctxWith(s));
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toMatch(/Разрешённых пока нет|винрейт появится/i);
  });

  it("нет ctx.market → trade_predict честная ошибка", async () => {
    const r = await dispatchTool("trade_predict", { symbol: "SBER", direction: "up", horizon: "1h" }, ctxWith(undefined));
    expect(r.isError).toBe(true);
  });

  it("tinkoff_portfolio без токена → честная ошибка (не выдумывает позиции)", async () => {
    const r = await dispatchTool("tinkoff_portfolio", {}, ctxWith(svc())); // svc без TinkoffProvider
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/токен|tinkoff/i);
  });
});

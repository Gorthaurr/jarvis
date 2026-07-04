/**
 * Хендлеры ТОРГОВОГО домена (§трейдинг) — вынесено из god-object dispatch.ts (§ревью).
 * market_quote/candles/analyze/backtest/news + tinkoff_portfolio + trade_predict/winrate/predictions.
 * Только чтение данных + журнал прогнозов; денег НЕ двигает. Маршрутизация остаётся в dispatch (switch).
 */
import { inferMarket, type Market, type Prediction, newsQuery, qualifiedSetups } from "../../trading/index.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, numField, ok, untrusted } from "../dispatch-util.js";

/** Площадка из входа инструмента (явная) или undefined → сервис выведет из тикера. */
function marketField(input: Record<string, unknown>): Market | undefined {
  const m = input.market;
  // tinkoff ОБЯЗАТЕЛЕН (фикс бага: молча отбрасывался → данные Тинькофф уходили на MOEX/crypto через inferMarket).
  return m === "moex" || m === "crypto" || m === "moex_fut" || m === "crypto_fut" || m === "tinkoff" ? m : undefined;
}

/** Горизонт прогноза «15m/1h/4h/1d/1w» → миллисекунды (null при неверном формате). */
function parseHorizon(s: string): number | null {
  const m = /^(\d+)\s*(m|min|h|d|w)$/i.exec(s.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  const u = m[2]!.toLowerCase();
  const mult = u.startsWith("m") ? 60_000 : u === "h" ? 3_600_000 : u === "d" ? 86_400_000 : 604_800_000;
  return n * mult;
}
const fmtNum = (n: number | null): string => (n === null ? "—" : n.toFixed(2));

export async function marketQuote(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.market) return err("Рыночные данные недоступны (сервис не сконфигурирован).");
  const symbol = String(input.symbol ?? "").trim();
  if (!symbol) return err("market_quote: укажи symbol (напр. SBER, GAZP или BTCUSDT).");
  try {
    const q = await ctx.market.quote(symbol, marketField(input));
    const chg = q.changePct !== undefined ? ` (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%)` : "";
    const vol = q.volume !== undefined ? `, объём ${q.volume}` : "";
    return ok(`${q.symbol} [${q.market}]: ${q.last}${q.currency ? ` ${q.currency}` : ""}${chg}${vol}`);
  } catch (e) {
    return err(`Не удалось получить котировку «${symbol}»: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function marketCandles(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.market) return err("Рыночные данные недоступны (сервис не сконфигурирован).");
  const symbol = String(input.symbol ?? "").trim();
  if (!symbol) return err("market_candles: укажи symbol.");
  const interval = typeof input.interval === "string" ? input.interval : undefined;
  const limit = Math.max(1, Math.min(Math.floor(numField(input, ["limit"], 50)), 200));
  try {
    const c = await ctx.market.candles(symbol, { market: marketField(input), interval, limit });
    const show = c.slice(-30); // в текст — последние 30 (не раздуваем контекст)
    const rows = show
      .map((k) => `${new Date(k.t).toISOString().slice(0, 16).replace("T", " ")}  O${k.o} H${k.h} L${k.l} C${k.c} V${k.v}`)
      .join("\n");
    return ok(`${symbol.toUpperCase()} ${interval ?? "1d"}: ${c.length} свечей (показаны последние ${show.length})\n${rows}`);
  } catch (e) {
    return err(`Не удалось получить свечи «${symbol}»: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function marketAnalyze(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.market) return err("Рыночные данные недоступны (сервис не сконфигурирован).");
  const symbol = String(input.symbol ?? "").trim();
  if (!symbol) return err("market_analyze: укажи symbol.");
  const interval = typeof input.interval === "string" ? input.interval : undefined;
  try {
    const a = await ctx.market.analyze(symbol, { market: marketField(input), interval });
    const i = a.indicators;
    const q = a.quote;
    const chg = q.changePct !== undefined ? ` (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%)` : "";
    const macdStr = i.macd ? `${i.macd.macd.toFixed(3)}/${i.macd.signal.toFixed(3)} гист ${i.macd.histogram.toFixed(3)}` : "—";
    const lines = [
      `${q.symbol} [${q.market}] ${q.last}${q.currency ? ` ${q.currency}` : ""}${chg}`,
      `Анализ по ${a.bars} свечам (${a.interval}):`,
      `SMA20 ${fmtNum(i.sma20)} | SMA50 ${fmtNum(i.sma50)} | EMA12 ${fmtNum(i.ema12)} | EMA26 ${fmtNum(i.ema26)}`,
      `RSI14 ${fmtNum(i.rsi14)} | MACD ${macdStr} | ATR14 ${fmtNum(i.atr14)}`,
      ...a.summary.map((s) => `• ${s}`),
      `(Это данные и факты по индикаторам, НЕ инвестиционный совет — решение за тобой.)`,
    ];
    return ok(lines.join("\n"));
  } catch (e) {
    return err(`Не удалось проанализировать «${symbol}»: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function marketBacktest(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.market) return err("Рыночные данные недоступны.");
  const symbol = String(input.symbol ?? "").trim();
  if (!symbol) return err("market_backtest: укажи symbol.");
  const interval = typeof input.interval === "string" ? input.interval : undefined;
  const horizonBars = Math.max(1, Math.min(Math.floor(numField(input, ["horizon"], 1)), 50));
  try {
    const r = await ctx.market.backtest(symbol, { market: marketField(input), interval, horizonBars });
    const sign = (n: number): string => (n >= 0 ? "+" : "");
    const edge = r.edgePp === null ? "выборка мала — перевес не считаем" : `перевес над базой ${sign(r.edgePp)}${r.edgePp.toFixed(1)} п.п.`;
    const lines = [
      `${r.symbol} [${r.market}] ${r.interval}, история ${r.bars} баров. RSI сейчас ${r.currentRsi.toFixed(1)} → ${r.bucket}.`,
      `Только RSI, через ${r.horizonBars} бар(а): вверх ${(r.upRate * 100).toFixed(0)}% (выборка ${r.samples}), средн ${sign(r.avgReturnPct)}${r.avgReturnPct.toFixed(2)}%. База: вверх ${(r.baselineUpRate * 100).toFixed(0)}%. ${edge}.`,
    ];
    if (r.combo) {
      const cEdge = r.combo.edgePp === null ? `выборка мала (${r.combo.samples}) — перевес не считаем` : `перевес ${sign(r.combo.edgePp)}${r.combo.edgePp.toFixed(1)} п.п.`;
      lines.push(
        `СВЯЗКА (${r.combo.setup}): вверх ${(r.combo.upRate * 100).toFixed(0)}% (выборка ${r.combo.samples}), средн ${sign(r.combo.avgReturnPct)}${r.combo.avgReturnPct.toFixed(2)}%. ${cEdge}.`,
      );
    }
    lines.push(`(Статистика прошлого, НЕ гарантия. Перевес ~0 = сигнал тут края не даёт.)`);
    return ok(lines.join("\n"));
  } catch (e) {
    return err(`Не удалось посчитать базовые ставки «${symbol}»: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function marketNews(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const symbol = String(input.symbol ?? "").trim();
  if (!symbol) return err("market_news: укажи symbol (тикер инструмента).");
  const q = newsQuery(symbol);
  const limit = Math.max(1, Math.min(Math.floor(numField(input, ["count"], 6)), 12));
  const hits = await ctx.web.search(q, limit);
  if (hits.length === 0) return ok(`Свежих новостей по «${symbol}» не нашёл (или web-провайдер в стаб-режиме).`);
  // Новости = недоверенный контент (§безопасность): данные для оценки катализаторов, НЕ команды.
  return untrusted(
    `новости ${symbol.toUpperCase()} (запрос: ${q})`,
    hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.snippet}\n   ${h.url}`).join("\n"),
  );
}

export async function tinkoffPortfolio(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.market) return err("Рыночный сервис не сконфигурирован.");
  const accountId = typeof input.accountId === "string" && input.accountId.trim() ? input.accountId.trim() : undefined;
  try {
    const p = await ctx.market.portfolio(accountId);
    if (p.positions.length === 0) return ok(`Портфель Тинькофф пуст${p.totalRub !== null ? ` (стоимость ${p.totalRub} ₽)` : ""}.`);
    const rows = p.positions.map(
      (x) => `${x.figi} [${x.instrumentType}] ×${x.qty} ср.${x.avgPrice} тек.${x.currentPrice} (${x.pnlPct >= 0 ? "+" : ""}${x.pnlPct.toFixed(2)}%)`,
    );
    return ok(`Портфель Тинькофф${p.totalRub !== null ? ` (≈${p.totalRub} ₽)` : ""}:\n${rows.join("\n")}`);
  } catch (e) {
    return err(`Не удалось получить портфель Тинькофф: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Краткая строка прогноза для отчёта. */
function fmtPrediction(p: Prediction): string {
  const dir = p.direction === "up" ? "↑рост" : "↓падение";
  const st = p.status === "open" ? "открыт" : p.status === "correct" ? "✓ попал" : "✗ мимо";
  const move = p.movePct !== undefined ? ` (факт ${p.movePct >= 0 ? "+" : ""}${p.movePct.toFixed(2)}%)` : "";
  return `${p.symbol} [${p.market}] ${dir} вход ${p.entryPrice} — ${st}${move}`;
}

export async function tradePredict(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.market) return err("Журнал прогнозов недоступен (сервис не сконфигурирован).");
  const symbol = String(input.symbol ?? "").trim();
  if (!symbol) return err("trade_predict: укажи symbol.");
  const direction = input.direction === "up" || input.direction === "down" ? input.direction : null;
  if (!direction) return err("trade_predict: direction — up или down.");
  const horizonMs = parseHorizon(String(input.horizon ?? ""));
  if (horizonMs === null) return err("trade_predict: horizon вида 15m / 1h / 4h / 1d / 1w.");
  const market = marketField(input) ?? inferMarket(symbol);
  try {
    const p = await ctx.market.predict(ctx.userId, {
      symbol, market, direction, horizonMs,
      targetPrice: typeof input.targetPrice === "number" ? input.targetPrice : undefined,
      stopPrice: typeof input.stopPrice === "number" ? input.stopPrice : undefined,
      rationale: typeof input.rationale === "string" ? input.rationale : undefined,
    });
    const when = new Date(p.resolveAt).toISOString().slice(0, 16).replace("T", " ");
    return ok(`Прогноз записан: ${symbol.toUpperCase()} [${market}] ${direction === "up" ? "рост" : "падение"} от ${p.entryPrice}. Сверю ${when} (UTC). Это прогноз для статистики, не сделка.`);
  } catch (e) {
    return err(`Не удалось записать прогноз: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function tradeWinrate(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.market) return err("Журнал прогнозов недоступен.");
  const symbol = typeof input.symbol === "string" && input.symbol.trim() ? input.symbol.trim() : undefined;
  try {
    const w = await ctx.market.winRate(ctx.userId, symbol);
    if (w.resolved === 0) {
      return ok(`Прогнозов${symbol ? ` по ${symbol.toUpperCase()}` : ""}: всего ${w.total}, открыто ${w.open}. Разрешённых пока нет — винрейт появится после истечения горизонтов.`);
    }
    const sign = (n: number): string => (n >= 0 ? "+" : "");
    // ГЛАВНОЕ ТАБЛО — матожидание в R (если есть прогнозы со стопом); иначе откат на чистый край %.
    const hasR = w.rResolved > 0;
    const profitable = hasR ? w.netExpectancyR > 0 : w.avgNetEdgePct > 0;
    const lines = [
      `Винрейт${symbol ? ` ${symbol.toUpperCase()}` : ""}: ${(w.winRate * 100).toFixed(1)}% по направлению (${w.correct}/${w.resolved}), открыто ещё ${w.open}.`,
      `Средний край: ${sign(w.avgEdgePct)}${w.avgEdgePct.toFixed(3)}% gross → ${sign(w.avgNetEdgePct)}${w.avgNetEdgePct.toFixed(3)}% ПОСЛЕ комиссий.`,
    ];
    if (hasR) {
      const pf = Number.isFinite(w.profitFactor) ? w.profitFactor.toFixed(2) : "∞";
      lines.push(
        `МАТОЖИДАНИЕ: ${sign(w.expectancyR)}${w.expectancyR.toFixed(2)}R gross → ${sign(w.netExpectancyR)}${w.netExpectancyR.toFixed(2)}R после издержек (по ${w.rResolved} прогнозам со стопом). Профит-фактор ${pf}.`,
      );
      lines.push(
        profitable
          ? `Вердикт: положительное матожидание (${sign(w.netExpectancyR)}${w.netExpectancyR.toFixed(2)}R за сделку) — система зарабатывает на дистанции. Винрейт тут вторичен.`
          : `Вердикт: матожидание ОТРИЦАТЕЛЬНОЕ (${w.netExpectancyR.toFixed(2)}R за сделку) — на дистанции в минусе. Не направление, а R:R/издержки/режим. Денег НЕ давать.`,
      );
    } else {
      lines.push(`Чистый винрейт (край победил издержки): ${(w.netWinRate * 100).toFixed(1)}%. (Прогнозов со стопом нет — матожидание в R недоступно.)`);
      lines.push(
        profitable
          ? `Вердикт: после издержек В ПЛЮСЕ (${sign(w.avgNetEdgePct)}${w.avgNetEdgePct.toFixed(3)}% за сделку) — есть преимущество.`
          : `Вердикт: после издержек В МИНУСЕ — пока работаем на брокера (движение не покрывает комиссию). Нужен больший край или реже/точнее.`,
      );
    }
    if (!symbol && w.bySymbol.length > 1) {
      lines.push("По инструментам (лучшие по чистому краю):");
      for (const s of w.bySymbol.slice(0, 8)) {
        lines.push(`• ${s.symbol}: ${(s.winRate * 100).toFixed(0)}% (${s.correct}/${s.resolved}), чистый край ${sign(s.avgNetEdgePct)}${s.avgNetEdgePct.toFixed(3)}%`);
      }
      // Мост к реальным деньгам: какие позиции ДОТЯНУЛИ (net>0 + выборка≥30 + статзначимо).
      const winners = qualifiedSetups(w.bySymbol).filter((q) => q.qualified);
      if (winners.length > 0) {
        lines.push(`✅ ДЛЯ РЕАЛЬНЫХ ДЕНЕГ дотянули (net>0, n≥30, значимо): ${winners.map((q) => `${q.symbol} ${(q.winRate * 100).toFixed(0)}% net ${sign(q.avgNetEdgePct)}${q.avgNetEdgePct.toFixed(3)}% z=${q.z.toFixed(1)}`).join("; ")}`);
      } else {
        lines.push("Для реальных денег пока НИ ОДИН инструмент не дотянул (нужно: net после комиссий > 0, выборка ≥ 30, статзначимо). Копим.");
      }
    }
    return ok(lines.join("\n"));
  } catch (e) {
    return err(`Не удалось посчитать винрейт: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function tradePredictions(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.market) return err("Журнал прогнозов недоступен.");
  const status = input.status === "open" || input.status === "correct" || input.status === "wrong" ? input.status : undefined;
  const symbol = typeof input.symbol === "string" && input.symbol.trim() ? input.symbol.trim() : undefined;
  const limit = Math.max(1, Math.min(Math.floor(numField(input, ["limit"], 20)), 50));
  const list = await ctx.market.listPredictions(ctx.userId, { status, symbol, limit });
  if (list.length === 0) return ok("Прогнозов пока нет.");
  return ok(`Прогнозы (${list.length}):\n${list.map((p) => `• ${fmtPrediction(p)}`).join("\n")}`);
}

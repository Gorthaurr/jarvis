/**
 * Рыночные данные (§трейдинг, слой 1) — КОТИРОВКИ и СВЕЧИ, ТОЛЬКО ЧТЕНИЕ, без денег и без ключей.
 *
 *  - MOEX: открытый ISS API (`iss.moex.com`, без ключа/лимитов) — акции МосБиржи.
 *  - Крипта: публичный REST Binance (`api.binance.com`) — тикер 24ч + klines.
 *
 * Сеть через глобальный fetch (Node 22). ЧЕСТНОСТЬ: сбой/нет данных → исключение или null, НИКОГДА
 * выдуманная цена. Парсеры — чистые экспортируемые функции (тест без сети). Mock для юнит-тестов.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { TinkoffProvider } from "./tinkoff.js";

const log: Logger = createLogger("market");

/**
 * Площадка инструмента: спот/фьючерс × MosBirzha/крипта (`_fut` — фьючерсы), либо `tinkoff` — РЕАЛЬНЫЕ
 * данные из Tinkoff Invest API (то, что в терминале: акции/фьючи/валюта по тикеру, в реальном времени).
 */
export type Market = "moex" | "crypto" | "moex_fut" | "crypto_fut" | "tinkoff";

/** Текущая котировка инструмента. */
export interface Quote {
  symbol: string;
  market: Market;
  last: number;
  /** Изменение за день в процентах (если отдаёт источник). */
  changePct?: number;
  /** Объём за день (в бумагах/контрактах источника). */
  volume?: number;
  currency?: string;
  /** unix ms среза. */
  ts: number;
}

/** Свеча OHLCV. `t` — unix ms открытия. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface IMarketDataProvider {
  quote(symbol: string, market: Market): Promise<Quote>;
  candles(symbol: string, market: Market, interval: string, limit: number): Promise<Candle[]>;
  /** Свечи за КОНКРЕТНОЕ ОКНО [startMs, endMs] (для path-сверки прогноза, чьё окно в прошлом). */
  candlesRange(symbol: string, market: Market, interval: string, startMs: number, endMs: number): Promise<Candle[]>;
  readonly live: boolean;
}

const TIMEOUT_MS = 8_000;
const MOEX_BASE = "https://iss.moex.com/iss";
const BINANCE_BASE = "https://api.binance.com/api/v3";
const BINANCE_FUT_BASE = "https://fapi.binance.com/fapi/v1"; // USDⓈ-M перпы (фьючерсы)

const isCrypto = (m: Market): boolean => m === "crypto" || m === "crypto_fut";
/** Путь движка ISS для котировки: фьючерсы FORTS vs спот-акции (борд TQBR). */
const moexQuoteBase = (m: Market): string =>
  m === "moex_fut" ? "engines/futures/markets/forts" : "engines/stock/markets/shares/boards/TQBR";
/** Путь движка ISS для свечей: фьючерсы FORTS vs спот-акции. */
const moexCandleBase = (m: Market): string =>
  m === "moex_fut" ? "engines/futures/markets/forts" : "engines/stock/markets/shares";

/** Интервал свечей → код MOEX ISS (минуты/день/неделя/месяц/квартал). */
const MOEX_INTERVAL: Record<string, number> = { "1m": 1, "10m": 10, "1h": 60, "1d": 24, "1w": 7, "1M": 31 };
/** Допустимые интервалы Binance (klines). */
const BINANCE_INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]);

/** Разобрать табличный ответ ISS ({columns:[],data:[[]]}) блока `block` в массив объектов. */
export function parseIssTable(json: unknown, block: string): Record<string, unknown>[] {
  const node = (json as Record<string, { columns?: unknown[]; data?: unknown[][] }>)?.[block];
  const cols = node?.columns;
  const data = node?.data;
  if (!Array.isArray(cols) || !Array.isArray(data)) return [];
  return data.map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      obj[String(c)] = (row as unknown[])[i];
    });
    return obj;
  });
}

/** Котировка MOEX из marketdata+securities (чистая). LAST → PREVPRICE-фолбэк (до открытия торгов). */
export function parseMoexQuote(json: unknown, symbol: string, market: Market = "moex"): Quote | null {
  const md = parseIssTable(json, "marketdata")[0];
  const sec = parseIssTable(json, "securities")[0];
  if (!md && !sec) return null;
  const last = num(md?.LAST) ?? num(md?.MARKETPRICE) ?? num(md?.LASTSETTLEPRICE) ?? num(sec?.PREVPRICE) ?? num(sec?.LASTSETTLEPRICE);
  if (last === null) return null;
  return {
    symbol: symbol.toUpperCase(),
    market,
    last,
    changePct: num(md?.LASTTOPREVPRICE) ?? undefined,
    volume: num(md?.VOLTODAY) ?? undefined,
    currency: typeof sec?.CURRENCYID === "string" ? sec.CURRENCYID : "RUB",
    ts: Date.now(),
  };
}

/**
 * Смещение московского времени от UTC в мс (+03:00, БЕЗ перехода на летнее время — MSK фиксирован с 2014).
 * ISS отдаёт `begin` как МОСКОВСКОЕ локальное wall-clock без таймзоны → чтобы получить корректный UTC-инстант,
 * вычитаем это смещение. Симметрично moexDate() прибавляет его при формировании from/till. Двойной парсинг
 * как UTC (было) давал сдвиг −3ч на записи и +3ч на запросе → окно path-сверки промахивалось по свечам.
 */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Свечи MOEX ISS (блок candles: open/close/high/low/value/volume/begin). `begin` — МОСКОВСКОЕ время (MSK, UTC+3). */
export function parseMoexCandles(json: unknown): Candle[] {
  return parseIssTable(json, "candles")
    .map((r) => ({
      // Трактуем как UTC (суффикс Z), затем сдвигаем на −3ч → корректный UTC-инстант момента МСК.
      t: Date.parse(`${String(r.begin).replace(" ", "T")}Z`) - MSK_OFFSET_MS,
      o: num(r.open) ?? 0,
      h: num(r.high) ?? 0,
      l: num(r.low) ?? 0,
      c: num(r.close) ?? 0,
      v: num(r.volume) ?? 0,
    }))
    .filter((c) => Number.isFinite(c.t));
}

/** klines Binance ([[openTime,o,h,l,c,v,...]]) → Candle[] (чистая). */
export function parseBinanceCandles(json: unknown): Candle[] {
  if (!Array.isArray(json)) return [];
  return json.map((r) => {
    const a = r as unknown[];
    return { t: Number(a[0]), o: Number(a[1]), h: Number(a[2]), l: Number(a[3]), c: Number(a[4]), v: Number(a[5]) };
  });
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * unix ms → строка даты MOEX ISS для параметров from/till. ISS ожидает МОСКОВСКОЕ wall-clock (MSK, UTC+3),
 * поэтому прибавляем +03:00 к UTC-инстанту и форматируем через getUTC* (сдвинутая дата → нужные компоненты).
 */
export function moexDate(ms: number): string {
  const d = new Date(ms + MSK_OFFSET_MS);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function getJson(url: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "JarvisBot/0.1 (+market-data)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} от ${new URL(url).host}`);
  return resp.json();
}

/** Боевой провайдер: реальные MOEX ISS + Binance + (опц.) Tinkoff Invest API. */
export class MarketDataProvider implements IMarketDataProvider {
  readonly live = true;
  /** Источник Тинькофф (если задан токен) — для market="tinkoff". */
  constructor(private readonly tinkoff?: TinkoffProvider) {}

  private requireTinkoff(): TinkoffProvider {
    if (!this.tinkoff) throw new Error("Tinkoff не подключён — задай TINKOFF_INVEST_TOKEN (read-only) в .env");
    return this.tinkoff;
  }

  async quote(symbol: string, market: Market): Promise<Quote> {
    const s = symbol.trim().toUpperCase();
    if (market === "tinkoff") return this.requireTinkoff().quote(s);
    if (!isCrypto(market)) {
      const url = `${MOEX_BASE}/${moexQuoteBase(market)}/securities/${encodeURIComponent(s)}.json?iss.meta=off`;
      const q = parseMoexQuote(await getJson(url), s, market);
      if (!q) throw new Error(`MOEX: нет данных по «${s}» (тикер, напр. ${market === "moex_fut" ? "фьючерс SiH5, BRG5" : "SBER, GAZP"})`);
      return q;
    }
    const base = market === "crypto_fut" ? BINANCE_FUT_BASE : BINANCE_BASE;
    const o = (await getJson(`${base}/ticker/24hr?symbol=${encodeURIComponent(s)}`)) as Record<string, string>;
    const last = num(o.lastPrice);
    if (last === null) throw new Error(`Крипта: нет данных по «${s}» (формат пары, напр. BTCUSDT)`);
    return { symbol: s, market, last, changePct: num(o.priceChangePercent) ?? undefined, volume: num(o.volume) ?? undefined, ts: Date.now() };
  }

  async candles(symbol: string, market: Market, interval: string, limit: number): Promise<Candle[]> {
    const s = symbol.trim().toUpperCase();
    const lim = Math.max(1, Math.min(limit, 500));
    if (market === "tinkoff") return this.requireTinkoff().candles(s, interval, lim);
    if (!isCrypto(market)) {
      const code = MOEX_INTERVAL[interval] ?? 24;
      const url = `${MOEX_BASE}/${moexCandleBase(market)}/securities/${encodeURIComponent(s)}/candles.json?iss.meta=off&interval=${code}&iss.reverse=true&limit=${lim}`;
      const c = parseMoexCandles(await getJson(url)).reverse(); // reverse=true → новейшие первыми → в хронологию
      if (c.length === 0) throw new Error(`MOEX: нет свечей по «${s}»`);
      return c;
    }
    const base = market === "crypto_fut" ? BINANCE_FUT_BASE : BINANCE_BASE;
    const iv = BINANCE_INTERVALS.has(interval) ? interval : "1d";
    const c = parseBinanceCandles(await getJson(`${base}/klines?symbol=${encodeURIComponent(s)}&interval=${iv}&limit=${lim}`));
    if (c.length === 0) throw new Error(`Крипта: нет свечей по «${s}»`);
    return c;
  }

  /** Свечи за ОКНО [startMs,endMs] (Binance startTime/endTime; MOEX from/till; tinkoff — недавние+фильтр). */
  async candlesRange(symbol: string, market: Market, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
    const s = symbol.trim().toUpperCase();
    if (market === "tinkoff") {
      const c = await this.requireTinkoff().candles(s, interval, 500);
      return c.filter((x) => x.t >= startMs && x.t <= endMs); // tinkoff API диапазон тут не принимаем — best-effort
    }
    if (!isCrypto(market)) {
      const code = MOEX_INTERVAL[interval] ?? 24;
      const url = `${MOEX_BASE}/${moexCandleBase(market)}/securities/${encodeURIComponent(s)}/candles.json?iss.meta=off&interval=${code}&from=${encodeURIComponent(moexDate(startMs))}&till=${encodeURIComponent(moexDate(endMs))}`;
      return parseMoexCandles(await getJson(url)); // ISS from/till → уже в хронологии
    }
    const base = market === "crypto_fut" ? BINANCE_FUT_BASE : BINANCE_BASE;
    const iv = BINANCE_INTERVALS.has(interval) ? interval : "1h";
    const url = `${base}/klines?symbol=${encodeURIComponent(s)}&interval=${iv}&startTime=${Math.floor(startMs)}&endTime=${Math.floor(endMs)}&limit=1000`;
    return parseBinanceCandles(await getJson(url));
  }
}

/** Mock для тестов: отдаёт заранее заданные котировку/свечи (или бросает). */
export class MockMarketDataProvider implements IMarketDataProvider {
  readonly live = false;
  constructor(
    private readonly q: Quote | null = null,
    private readonly c: Candle[] = [],
  ) {}
  async quote(symbol: string, market: Market): Promise<Quote> {
    if (!this.q) throw new Error("mock: нет котировки");
    return { ...this.q, symbol: symbol.toUpperCase(), market };
  }
  async candles(): Promise<Candle[]> {
    if (this.c.length === 0) throw new Error("mock: нет свечей");
    return this.c;
  }
  async candlesRange(): Promise<Candle[]> {
    return this.c; // mock: те же свечи (диапазон не моделируем)
  }
}

export { log as marketLog };

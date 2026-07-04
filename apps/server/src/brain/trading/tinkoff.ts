/**
 * Tinkoff Invest API (§трейдинг: РЕАЛЬНЫЙ Тинькофф в реальном времени) — REST-gateway к gRPC-контракту.
 *
 * То, что показывает терминал Тинькофф: котировки/свечи/портфель НАПРЯМУЮ из источника. Для теста хватает
 * READ-ONLY токена (торговать не может = безопасно). Токен — env `TINKOFF_INVEST_TOKEN`, НЕ в коде.
 * Честность: нет токена/инструмента/цены → исключение, НИКОГДА выдуманное число. Парсеры — чистые (тест
 * без сети). Цены приходят как Quotation {units,nano} → units + nano/1e9.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { Candle, Quote } from "./market.js";

const log: Logger = createLogger("tinkoff");

const BASE = "https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1";
const TIMEOUT_MS = 8_000;

/** Интервал → enum Tinkoff + длительность (для окна свечей). */
const TINKOFF_INTERVAL: Record<string, { e: string; ms: number }> = {
  "1m": { e: "CANDLE_INTERVAL_1_MIN", ms: 60_000 },
  "5m": { e: "CANDLE_INTERVAL_5_MIN", ms: 300_000 },
  "15m": { e: "CANDLE_INTERVAL_15_MIN", ms: 900_000 },
  "1h": { e: "CANDLE_INTERVAL_HOUR", ms: 3_600_000 },
  "1d": { e: "CANDLE_INTERVAL_DAY", ms: 86_400_000 },
  "1w": { e: "CANDLE_INTERVAL_WEEK", ms: 604_800_000 },
};

/** Quotation/MoneyValue {units,nano} → число (чистая). */
export function tinkoffNum(q: unknown): number | null {
  if (!q || typeof q !== "object") return null;
  const o = q as { units?: unknown; nano?: unknown };
  const units = Number(o.units ?? 0);
  const nano = Number(o.nano ?? 0);
  return Number.isFinite(units) && Number.isFinite(nano) ? units + nano / 1e9 : null;
}

/** Свечи Tinkoff (GetCandles.candles) → Candle[] (чистая). */
export function parseTinkoffCandles(json: unknown): Candle[] {
  const arr = (json as { candles?: unknown[] })?.candles;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => {
      const c = r as Record<string, unknown>;
      return {
        t: Date.parse(String(c.time)),
        o: tinkoffNum(c.open) ?? 0,
        h: tinkoffNum(c.high) ?? 0,
        l: tinkoffNum(c.low) ?? 0,
        c: tinkoffNum(c.close) ?? 0,
        v: Number(c.volume ?? 0),
      };
    })
    .filter((c) => Number.isFinite(c.t));
}

/** Позиция портфеля Тинькофф. */
export interface TinkoffPosition {
  figi: string;
  instrumentType: string;
  qty: number;
  avgPrice: number;
  currentPrice: number;
  pnlPct: number;
}

/** Портфель из GetPortfolio (чистая): позиции + суммарная стоимость. */
export function parseTinkoffPortfolio(json: unknown): { positions: TinkoffPosition[]; totalRub: number | null } {
  const j = json as { positions?: unknown[]; totalAmountPortfolio?: unknown };
  const positions = (Array.isArray(j?.positions) ? j.positions : []).map((p) => {
    const o = p as Record<string, unknown>;
    const avg = tinkoffNum(o.averagePositionPrice) ?? 0;
    const cur = tinkoffNum(o.currentPrice) ?? 0;
    return {
      figi: String(o.figi ?? ""),
      instrumentType: String(o.instrumentType ?? ""),
      qty: tinkoffNum(o.quantity) ?? 0,
      avgPrice: avg,
      currentPrice: cur,
      pnlPct: avg > 0 ? ((cur - avg) / avg) * 100 : 0,
    };
  });
  return { positions, totalRub: tinkoffNum(j?.totalAmountPortfolio) };
}

interface Instrument {
  uid: string;
  figi: string;
  ticker: string;
  type: string;
  currency: string;
}

/** Боевой клиент Tinkoff Invest API. */
export class TinkoffProvider {
  readonly live = true;
  private readonly cache = new Map<string, Instrument>();

  constructor(private readonly token: string) {}

  private async post(service: string, method: string, body: unknown): Promise<unknown> {
    const resp = await fetch(`${BASE}.${service}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Tinkoff ${method} HTTP ${resp.status}${txt ? `: ${txt.slice(0, 160)}` : ""}`);
    }
    return resp.json();
  }

  private async search(key: string, apiFlag: boolean): Promise<Array<Record<string, unknown>>> {
    const j = (await this.post("InstrumentsService", "FindInstrument", { query: key, apiTradeAvailableFlag: apiFlag })) as {
      instruments?: Array<Record<string, unknown>>;
    };
    return j.instruments ?? [];
  }

  /**
   * Тикер → инструмент (figi/uid). Кэш. FindInstrument по «SBER» отдаёт СОТНИ результатов (облигации и пр.) —
   * поэтому: сначала только API-торгуемые, и предпочитаем ТОЧНОЕ совпадение тикера + торгуемость (иначе
   * первым шёл бонд без последней цены → «нет цены»). Пусто → расширяем поиск (apiFlag=false).
   */
  async findInstrument(ticker: string): Promise<Instrument> {
    const key = ticker.trim().toUpperCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    let list = await this.search(key, true);
    if (list.length === 0) list = await this.search(key, false);
    const exact = list.filter((i) => String(i.ticker).toUpperCase() === key);
    const inst = exact.find((i) => i.apiTradeAvailableFlag === true) ?? exact[0] ?? list.find((i) => i.apiTradeAvailableFlag === true) ?? list[0];
    if (!inst) throw new Error(`Tinkoff: инструмент «${ticker}» не найден`);
    const out: Instrument = {
      uid: String(inst.uid ?? ""),
      figi: String(inst.figi ?? ""),
      ticker: String(inst.ticker ?? key),
      type: String(inst.instrumentType ?? ""),
      currency: String(inst.currency ?? "rub").toUpperCase(),
    };
    this.cache.set(key, out);
    return out;
  }

  /** Текущая котировка (последняя цена) из Тинькофф. */
  async quote(ticker: string): Promise<Quote> {
    const inst = await this.findInstrument(ticker);
    const j = (await this.post("MarketDataService", "GetLastPrices", { instrumentId: [inst.uid] })) as {
      lastPrices?: Array<{ price?: unknown }>;
    };
    const price = tinkoffNum(j.lastPrices?.[0]?.price);
    if (price === null) throw new Error(`Tinkoff: нет цены по «${ticker}»`);
    return { symbol: inst.ticker, market: "tinkoff", last: price, currency: inst.currency, ts: Date.now() };
  }

  /** Свечи из Тинькофф за окно `limit`·интервал. */
  async candles(ticker: string, interval: string, limit: number): Promise<Candle[]> {
    const inst = await this.findInstrument(ticker);
    const iv = TINKOFF_INTERVAL[interval] ?? TINKOFF_INTERVAL["1d"]!;
    const lim = Math.max(1, Math.min(limit, 300));
    const to = Date.now();
    const from = to - lim * iv.ms;
    const j = await this.post("MarketDataService", "GetCandles", {
      instrumentId: inst.uid,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      interval: iv.e,
    });
    const c = parseTinkoffCandles(j);
    if (c.length === 0) throw new Error(`Tinkoff: нет свечей по «${ticker}»`);
    return c;
  }

  /** Счета пользователя. */
  async accounts(): Promise<Array<{ id: string; name: string }>> {
    const j = (await this.post("UsersService", "GetAccounts", {})) as { accounts?: Array<Record<string, unknown>> };
    return (j.accounts ?? []).map((a) => ({ id: String(a.id ?? ""), name: String(a.name ?? "") }));
  }

  /** Реальный портфель (read-only): позиции + суммарная стоимость. */
  async portfolio(accountId?: string): Promise<{ accountId: string; positions: TinkoffPosition[]; totalRub: number | null }> {
    const acc = accountId ?? (await this.accounts())[0]?.id;
    if (!acc) throw new Error("Tinkoff: счёт не найден (проверь токен)");
    const j = await this.post("OperationsService", "GetPortfolio", { accountId: acc });
    return { accountId: acc, ...parseTinkoffPortfolio(j) };
  }
}

/** Фабрика из env (null без токена — честная деградация: market=tinkoff вернёт ошибку). */
export function makeTinkoffProvider(): TinkoffProvider | undefined {
  const token = process.env.TINKOFF_INVEST_TOKEN?.trim();
  if (!token) {
    log.info("TINKOFF_INVEST_TOKEN не задан — источник Тинькофф выключен");
    return undefined;
  }
  log.info("Tinkoff Invest API активен (read-only данные)");
  return new TinkoffProvider(token);
}

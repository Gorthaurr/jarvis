/**
 * РИСК-ДВИЖОК (§трейдинг, слой исполнения): размер позиции по риску + ДИВЕРСИФИКАЦИЯ.
 *
 * Правило (Антон + канон Van Tharp): даже на успешном инструменте НЕ лить весь баланс. Лимиты:
 *  - риск на сделку — малый % баланса (стоп), позиция считается ОТ риска, не от «сколько не жалко»;
 *  - макс доля баланса в ОДИН инструмент;
 *  - макс доля в КОРРЕЛИРОВАННЫЙ КЛАСТЕР (вся крипта ходит вместе → 5 монет это ОДНА ставка, не диверсификация);
 *  - макс число одновременных позиций; буфер кэша.
 * Чистые функции — детерминированы, тестируются без денег. Это рельсы для будущего исполнения.
 */
import type { Market } from "./market.js";

export interface RiskLimits {
  /** % баланса в РИСК на сделку (расстояние до стопа). */
  riskPerTradePct: number;
  /** Макс % баланса в ОДИН инструмент. */
  maxPositionPct: number;
  /** Макс % баланса в коррелированный КЛАСТЕР (напр. вся крипта). */
  maxClusterPct: number;
  /** Макс число одновременных позиций. */
  maxConcurrent: number;
  /** Мин % кэша всегда свободен (не входим в рынок на 100%). */
  cashBufferPct: number;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  riskPerTradePct: 1,
  maxPositionPct: 20,
  maxClusterPct: 50,
  maxConcurrent: 6,
  cashBufferPct: 10,
};

/** Коррелированный кластер площадки: вся крипта = один кластер, МосБиржа = другой. */
export function clusterOf(market: Market): string {
  return market === "crypto" || market === "crypto_fut" ? "crypto" : "moex";
}

/**
 * Размер позиции ОТ РИСКА: qty такое, что (|вход−стоп|)·qty = riskPerTradePct·баланс, но НЕ больше
 * maxPositionPct·баланс по нотионалу. Без валидного стопа (>0 расстояние) → 0 (не угадываем размер).
 */
export function positionSize(balance: number, entry: number, stop: number, limits: RiskLimits): number {
  const perUnitRisk = Math.abs(entry - stop);
  if (balance <= 0 || entry <= 0 || perUnitRisk <= 0) return 0;
  const riskMoney = (balance * limits.riskPerTradePct) / 100;
  const byRisk = riskMoney / perUnitRisk;
  const maxNotional = (balance * limits.maxPositionPct) / 100;
  return Math.min(byRisk, maxNotional / entry);
}

/** Открытая позиция (вид для проверки диверсификации). */
export interface OpenPosition {
  symbol: string;
  cluster: string;
  notional: number;
}

/**
 * Можно ли ДОБАВИТЬ позицию без нарушения диверсификации. Проверяет: лимит на инструмент, на кластер,
 * число позиций, буфер кэша. Возвращает ok + причину отказа (для честного отчёта).
 */
export function canAdd(
  balance: number,
  current: readonly OpenPosition[],
  add: { symbol: string; cluster: string; notional: number },
  limits: RiskLimits,
): { ok: boolean; reason: string } {
  if (balance <= 0 || add.notional <= 0) return { ok: false, reason: "нет баланса/нулевой объём" };
  const sym = (p: OpenPosition): number => (p.symbol.toUpperCase() === add.symbol.toUpperCase() ? p.notional : 0);
  const symNotional = current.reduce((s, p) => s + sym(p), 0) + add.notional;
  if (symNotional > (balance * limits.maxPositionPct) / 100) {
    return { ok: false, reason: `лимит на «${add.symbol}» (${limits.maxPositionPct}% баланса) превышен` };
  }
  const clusterNotional = current.reduce((s, p) => s + (p.cluster === add.cluster ? p.notional : 0), 0) + add.notional;
  if (clusterNotional > (balance * limits.maxClusterPct) / 100) {
    return { ok: false, reason: `лимит на кластер «${add.cluster}» (${limits.maxClusterPct}%) превышен — он коррелирован, это одна ставка` };
  }
  const distinct = new Set(current.map((p) => p.symbol.toUpperCase()));
  if (!distinct.has(add.symbol.toUpperCase()) && distinct.size >= limits.maxConcurrent) {
    return { ok: false, reason: `достигнут максимум одновременных позиций (${limits.maxConcurrent})` };
  }
  const totalNotional = current.reduce((s, p) => s + p.notional, 0) + add.notional;
  if (totalNotional > (balance * (100 - limits.cashBufferPct)) / 100) {
    return { ok: false, reason: `нарушает буфер кэша (${limits.cashBufferPct}% всегда свободно)` };
  }
  return { ok: true, reason: "ок" };
}

/** Лимиты из env (универсально, тюнинг без кода). */
export function riskLimitsFromEnv(): RiskLimits {
  const pct = (key: string, dflt: number): number => {
    const n = Number.parseFloat(process.env[key] ?? "");
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    riskPerTradePct: pct("JARVIS_RISK_PER_TRADE_PCT", DEFAULT_RISK_LIMITS.riskPerTradePct),
    maxPositionPct: pct("JARVIS_RISK_MAX_POSITION_PCT", DEFAULT_RISK_LIMITS.maxPositionPct),
    maxClusterPct: pct("JARVIS_RISK_MAX_CLUSTER_PCT", DEFAULT_RISK_LIMITS.maxClusterPct),
    maxConcurrent: Math.max(1, Math.floor(pct("JARVIS_RISK_MAX_CONCURRENT", DEFAULT_RISK_LIMITS.maxConcurrent))),
    cashBufferPct: pct("JARVIS_RISK_CASH_BUFFER_PCT", DEFAULT_RISK_LIMITS.cashBufferPct),
  };
}

/**
 * Модель ИЗДЕРЖЕК сделки (§трейдинг: «будет прибыль или работаем на брокера»).
 *
 * Круговая стоимость сделки (туда-обратно), % от нотионала: комиссия брокера ×2 стороны + биржевой сбор
 * + оценка спреда/проскальзывания. Прогноз «окупается» только если движение в его сторону БОЛЬШЕ издержек.
 *
 * Зависит от тарифа/инструмента → НАСТРАИВАЕМО через env (тариф у каждого свой). Дефолты — ориентир
 * (Tinkoff «Трейдер»-подобный + ликвидная крипта); честно показываем допущение в отчёте винрейта.
 *   - акции/Тинькофф (moex/tinkoff): JARVIS_COST_SHARES_PCT  (деф 0.1% круг; «Инвестор»-тариф ≈ 0.6%)
 *   - крипта (crypto/crypto_fut):    JARVIS_COST_CRYPTO_PCT  (деф 0.2% круг = тейкер 0.1% ×2)
 *   - фьючерсы MOEX (moex_fut):      JARVIS_COST_FUT_PCT     (деф 0.04% круг — комиссия за контракт мала)
 */
import type { Market } from "./market.js";

const DEFAULT_SHARES = 0.1;
const DEFAULT_CRYPTO = 0.2;
const DEFAULT_FUT = 0.04;

function envPct(key: string, fallback: number): number {
  const n = Number.parseFloat(process.env[key] ?? "");
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Круговая издержка (%, туда-обратно) для площадки. */
export function roundTripCostPct(market: Market): number {
  if (market === "crypto" || market === "crypto_fut") return envPct("JARVIS_COST_CRYPTO_PCT", DEFAULT_CRYPTO);
  if (market === "moex_fut") return envPct("JARVIS_COST_FUT_PCT", DEFAULT_FUT);
  return envPct("JARVIS_COST_SHARES_PCT", DEFAULT_SHARES); // moex / tinkoff
}

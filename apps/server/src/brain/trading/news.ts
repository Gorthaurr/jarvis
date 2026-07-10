/**
 * НОВОСТИ по инструменту (§трейдинг: волатильные имена торгуют по катализаторам/новостям, не по RSI).
 *
 * Строит осмысленный поисковый запрос из тикера (BTCUSDT→Bitcoin, SBER→Сбербанк) — чистая функция,
 * тестируется без сети. Сам поиск — через web-провайдера мозга (см. dispatch). Новости = ДАННЫЕ для
 * рассуждения (не команды, оборачиваются untrusted). Это не риалтайм-фид, а веб-поиск свежего — честно.
 */

/** Тикер крипто-пары → имя монеты для поиска новостей. */
const CRYPTO_NAMES: Record<string, string> = {
  BTCUSDT: "Bitcoin BTC",
  ETHUSDT: "Ethereum ETH",
  SOLUSDT: "Solana SOL",
  BNBUSDT: "BNB Binance Coin",
  XRPUSDT: "XRP Ripple",
  ADAUSDT: "Cardano ADA",
  AVAXUSDT: "Avalanche AVAX",
  LINKUSDT: "Chainlink LINK",
  DOGEUSDT: "Dogecoin DOGE",
  LTCUSDT: "Litecoin LTC",
};

/** Тикер МосБиржи → название эмитента. */
const MOEX_NAMES: Record<string, string> = {
  SBER: "Сбербанк",
  GAZP: "Газпром",
  LKOH: "Лукойл",
  VTBR: "ВТБ",
  ROSN: "Роснефть",
  GMKN: "Норникель",
  YNDX: "Яндекс",
  TATN: "Татнефть",
  MGNT: "Магнит",
};

/** Построить поисковый запрос новостей по инструменту (чистая). */
export function newsQuery(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (CRYPTO_NAMES[s]) return `${CRYPTO_NAMES[s]} crypto news`;
  if (MOEX_NAMES[s]) return `${MOEX_NAMES[s]} акции новости`;
  if (/USDT$/.test(s) || /USD$/.test(s)) return `${s.replace(/USDT?$/, "")} crypto news`;
  return `${s} акции новости`;
}

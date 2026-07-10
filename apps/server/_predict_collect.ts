/**
 * РАЗОВЫЙ СБОРЩИК выборки прогнозов с LLM-экспертом, с ЖЁСТКИМ потолком трат (по умолчанию $10).
 * НЕ трогает .env-флаги (чтобы эксперт не включался на каждом старте сервера). Бюджет исчерпан →
 * эксперт молчит, цикл идёт без расхода → выходим. Запуск (PowerShell, фон):
 *   npx tsx _predict_collect.ts
 */
import { readFileSync } from "node:fs";
import { AnthropicLlmProvider } from "./src/integrations/anthropic.js";
import { KnowledgeBase } from "./src/brain/knowledge/index.js";
import { AutoPredictor, MarketDataProvider, TradeExpert, TradingService, loadPredictionStore, makeTinkoffProvider } from "./src/brain/trading/index.js";

// .env (ANTHROPIC_API_KEY, TINKOFF, тарифы издержек) — без записи флагов в файл.
try {
  const env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
} catch {}

const DEV = "00000000-0000-0000-0000-000000000001";
const BUDGET_USD = Number.parseFloat(process.env.COLLECT_BUDGET_USD ?? "") || 10;
const INTERVAL_MS = 150_000; // 2.5 мин между проходами (вежливо к API)
const MAX_TICKS = 300; // предохранитель от зомби (≈12.5ч)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const store = loadPredictionStore("data");
const svc = new TradingService(new MarketDataProvider(makeTinkoffProvider()), store, makeTinkoffProvider());
const llm = new AnthropicLlmProvider({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", baseUrl: process.env.ANTHROPIC_BASE_URL });
const expert = new TradeExpert(llm, new KnowledgeBase(), {
  model: process.env.TIER3_MODEL ?? "claude-opus-4-8",
  tier: "fable",
  budgetUsd: BUDGET_USD,
});

// Вотчлист: крипто-мажоры × {1h, 4h} — больше кандидатов → быстрее выборка + расход бюджета.
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOGEUSDT", "LTCUSDT"];
const tfs = ["1h", "4h"];
const watch = symbols.flatMap((symbol) => tfs.map((tf) => ({ symbol, market: "crypto" as const, tf })));
const cfg = { userId: DEV, watch, intervalMs: INTERVAL_MS, minSamples: 25, minUpRate: 0.55, minScore: 2, levelPct: 0.015 };
const ap = new AutoPredictor(svc, cfg, expert);

console.log(`[collect] СТАРТ: бюджет $${BUDGET_USD}, ${watch.length} кандидатов/тик (10 крипто × 1h,4h), интервал ${INTERVAL_MS / 1000}с`);
console.log(`[collect] LLM live: ${llm.live}; журнал на старте: ${store.list(DEV).length} прогнозов`);

let tick = 0;
const startCount = store.list(DEV).length;
while (tick < MAX_TICKS && !expert.budgetExhausted()) {
  tick += 1;
  const before = store.list(DEV).length;
  const t0 = Date.now();
  try {
    await ap.tick();
  } catch (e) {
    console.log(`[collect] тик ${tick} ошибка: ${e instanceof Error ? e.message : String(e)}`);
  }
  const all = store.list(DEV);
  const fresh = all.filter((p) => p.createdAt >= t0 - 2000 && p.stopPrice != null);
  const spent = expert.spentUsd();
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[collect ${ts}] тик ${tick}: +${fresh.length} прогноз(ов) со стопом | журнал ${before}→${all.length} | потрачено $${spent.toFixed(3)}/$${BUDGET_USD}`);
  for (const p of fresh) {
    const e = p.entryPrice;
    const rr = p.stopPrice != null && p.targetPrice != null ? Math.abs(p.targetPrice - e) / Math.abs(e - p.stopPrice) : null;
    console.log(`    + ${p.symbol} ${p.direction.toUpperCase()} вход=${e} стоп=${p.stopPrice} тейк=${p.targetPrice} R:R=${rr ? rr.toFixed(2) : "—"}`);
  }
  if (expert.budgetExhausted()) break;
  await sleep(INTERVAL_MS);
}

const added = store.list(DEV).length - startCount;
const withStops = store.list(DEV).filter((p) => p.stopPrice != null).length;
console.log(`\n[collect] ФИНИШ: тиков ${tick}, потрачено $${expert.spentUsd().toFixed(3)} (лимит $${BUDGET_USD}). Добавлено прогнозов: ${added}. Всего со стопами в журнале: ${withStops}.`);
console.log(`[collect] Дальше: дать им дозреть по горизонту → trade_winrate покажет МАТОЖИДАНИЕ в R по живой выборке.`);

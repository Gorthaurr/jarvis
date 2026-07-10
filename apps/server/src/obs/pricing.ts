/**
 * Per-model тарифы токенов — ЕДИНЫЙ источник истины (§14/obs).
 *
 * РАНЬШЕ стоимость считалась В ДВУХ местах по РАЗНЫМ и обоим НЕВЕРНЫМ тарифам: SpendGuard
 * (`estimateCost` в agent/index) прайсил ВСЁ по Haiku ($1/$5) → занижал Opus в 5×; obs/metrics
 * (`estimateCostUsd`) — по старому Opus $15/$75 → завышал в 3× и Haiku в 15×. Обе игнорировали
 * фактическую модель хода. Теперь и гейтинг трат (§14), и наблюдаемость ($/токены) считают ОТСЮДА.
 *
 * Цены — USD за 1M токенов, live-fetch 2026-06-22 (platform.claude.com/docs/.../pricing).
 * cacheWrite в таблице — ставка записи кеша 5m TTL (1.25× input). Для 1h TTL запись = 2× input —
 * с Волны 1 (2026-07-10) расчёт берёт ФАКТИЧЕСКИЙ TTL из ANTHROPIC_CACHE_TTL (см. cacheWriteRate):
 * проект живёт на 1h, и 5m-аппроксимация занижала cache-write на 37.5% (в эпизоде это 60% чека).
 */

/** Тариф одной модели (USD за 1M токенов). */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Семейство модели — ключ тарифа. */
export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable";

/** Тарифы по семействам (live-fetch 2026-06-22). */
export const MODEL_PRICING: Record<ModelFamily, ModelPricing> = {
  opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // Fable 5 — флагман-тир (заменяет opus как tier3); официальный прайс не подтверждён на момент
  // написания → берём как Opus (консервативно: дороже не занизит гейтинг трат).
  fable: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/**
 * Разрешить тариф по id модели (подстрочный матч). Неизвестная модель → Opus (самый дорогой):
 * для SpendGuard это консервативно (не занизим траты и не обойдём потолок §14); для телеметрии —
 * лишь слегка завысит редкий неизвестный id.
 */
export function pricingForModel(model: string): ModelPricing {
  const m = (model || "").toLowerCase();
  if (m.includes("haiku")) return MODEL_PRICING.haiku;
  if (m.includes("sonnet")) return MODEL_PRICING.sonnet;
  if (m.includes("opus")) return MODEL_PRICING.opus;
  if (m.includes("fable")) return MODEL_PRICING.fable;
  return MODEL_PRICING.opus;
}

/** Разбивка токенов одного вызова по типам (из usage ответа Anthropic). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Ставка записи кеша с учётом TTL (Волна 1, ревью 2026-07-10): 5m = 1.25× input (табличная),
 * 1h = 2× input. Проект живёт с ANTHROPIC_CACHE_TTL=1h — прежний расчёт по 1.25× ЗАНИЖАЛ
 * cache-write стоимость на 37.5% → SpendGuard недоучитывал траты (в эпизоде cache-write = 60% чека).
 * opts.cacheTtl — для чистых тестов; без него читаем env (как её читает anthropic.ts).
 */
export function cacheWriteRate(p: ModelPricing, cacheTtl?: "5m" | "1h"): number {
  const ttl = cacheTtl ?? (process.env.ANTHROPIC_CACHE_TTL === "1h" ? "1h" : "5m");
  return ttl === "1h" ? p.input * 2 : p.cacheWrite;
}

/**
 * Стоимость вызова в USD по ФАКТИЧЕСКОЙ модели. Каждый тип токенов × свой тариф / 1e6.
 * Не-конечные значения коэрсятся в 0 (стрим оборвался → usage может прийти NaN; иначе spent стал бы NaN
 * и предохранитель §14 молча отключился бы). Запись кеша — по фактическому TTL (см. cacheWriteRate).
 */
export function costUsd(model: string, u: TokenUsage, opts?: { cacheTtl?: "5m" | "1h" }): number {
  const p = pricingForModel(model);
  const n = (x: number): number => (Number.isFinite(x) ? x : 0);
  return (
    (n(u.inputTokens) * p.input +
      n(u.outputTokens) * p.output +
      n(u.cacheReadTokens) * p.cacheRead +
      n(u.cacheCreationTokens) * cacheWriteRate(p, opts?.cacheTtl)) /
    1_000_000
  );
}

/**
 * Пауза полуоткрытого предохранителя основного канала (API по ключу) после подряд отказов — вынесено из
 * fallback-llm.ts. Мотив паузы — СКОРОСТЬ: не тратить секунды хода на заведомо мёртвый HTTP-запрос.
 */
import type { ApiFailureKind } from "./api-error-classify.js";

/**
 * Общая пауза (мс), `JARVIS_PRIMARY_COOLDOWN_MS`, деф 5 мин; 0 — предохранитель выключен.
 * Пустая строка → дефолт (та же грабля, что у перепроверки: Number("") === 0 обнулял бы паузу и возвращал
 * обречённые вызовы каждым ходом).
 */
function breakerCooldownMs(): number {
  const raw = (process.env.JARVIS_PRIMARY_COOLDOWN_MS ?? "").trim();
  if (!raw) return 300_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 300_000;
}

/**
 * Гео-блок (403 «Request not allowed» без VPN, C3) — транзиентный, но не минутный: пока VPN не поднят, общая
 * 5-минутная пауза давала по 2 заведомо мёртвых вызова в каждое окно (адверс-ревью р1). Латчем (как баланс/ключ)
 * не делаем: VPN поднимется сам, и полуоткрытая проба это увидит. Нового флага нет — берём не меньше общей паузы.
 */
const REGION_COOLDOWN_MS = 30 * 60_000;

/** Пауза для последнего отказа: region — не короче 30 мин; 0 (предохранитель выключен владельцем) — 0 для всех. */
export function transientCooldownMs(kind: ApiFailureKind | undefined): number {
  const base = breakerCooldownMs();
  return kind === "region" && base > 0 ? Math.max(base, REGION_COOLDOWN_MS) : base;
}

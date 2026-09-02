/**
 * Durable-состояние предупреждений квоты (usage_quota.warned_80_at/warned_100_at/soft_pct) и сборка
 * `UsageInfo` для клиента (вкладка «Оплата»). Пользователю показываем КРЕДИТЫ: 1 кредит = 1 ₽ по курсу
 * периода (JARVIS_RUB_PER_USD, деф 85), внутри всё в µ$/USD. Чистая `buildUsageInfo` — без IO и env.
 */
import type { UsageInfo } from "@jarvis/protocol";
import { ensureUser } from "../db/users.js";
import { ProductError, iso, ms, num, q } from "./db.js";
import type { QuotaLimits } from "./quota.js";

export type WarnKind = "80" | "100";

export interface WarnedState {
  warned80At: number | null;
  warned100At: number | null;
  softPct: number;
  costMicro: number;
}

export function rubPerUsdFromEnv(source: NodeJS.ProcessEnv = process.env): number {
  const v = Number.parseFloat(source.JARVIS_RUB_PER_USD ?? "85");
  return Number.isFinite(v) && v > 0 ? v : 85;
}

export async function readWarnedState(userId: string, period: string): Promise<WarnedState> {
  const rows = await q<Record<string, unknown>>(
    "select warned_80_at, warned_100_at, soft_pct, cost_micro from usage_quota where user_id = $1 and period = $2",
    [userId, period],
  );
  const r = rows[0];
  const soft = r ? num(r.soft_pct) : 80;
  return {
    warned80At: r ? ms(r.warned_80_at) : null,
    warned100At: r ? ms(r.warned_100_at) : null,
    softPct: soft > 0 && soft < 100 ? soft : 80,
    costMicro: r ? num(r.cost_micro) : 0,
  };
}

/** Отметить порог произнесённым (durable, один раз: повторная отметка не двигает время первой). */
export async function markWarned(userId: string, period: string, kind: WarnKind, now: number): Promise<void> {
  if (kind !== "80" && kind !== "100") throw new ProductError("invalid_input", `порог: 80 | 100, получено ${String(kind)}`);
  const col = kind === "80" ? "warned_80_at" : "warned_100_at";
  await ensureUser(userId);
  await q(
    `insert into usage_quota (user_id, period, ${col}) values ($1,$2,$3)
     on conflict (user_id, period) do update set ${col} = coalesce(usage_quota.${col}, excluded.${col}), updated_at = now()`,
    [userId, period, iso(now)],
  );
}

export interface SpendSnapshot {
  period: string;
  spent: number;
  cap: number;
  remaining: number;
  killSwitch: boolean;
}

/** UsageInfo из лимитов плана, снимка SpendGuard и durable-порогов. Кредиты округляются до целых. */
export function buildUsageInfo(limits: QuotaLimits, snap: SpendSnapshot, warned: WarnedState, rubPerUsd: number): UsageInfo {
  // Кап 0 при ненулевых тратах — это «исчерпано», а не «0% из ничего» (ревью 2026-09-02: expired-план с
  // тратами показывал 0% и warn=null).
  const spentPct = snap.cap > 0 ? (snap.spent / snap.cap) * 100 : snap.spent > 0 ? 100 : 0;
  const warn: UsageInfo["warn"] =
    warned.warned100At !== null || spentPct >= 100 ? "100" : warned.warned80At !== null || spentPct >= limits.softPct ? "80" : null;
  const info: UsageInfo = {
    plan: limits.planName ?? "Без тарифа",
    period: snap.period,
    spent: snap.spent,
    cap: snap.cap,
    remaining: snap.remaining,
    killSwitch: snap.killSwitch,
    currency: "USD",
    status: limits.status,
    warn,
    softPct: limits.softPct,
  };
  if (limits.planId) info.planId = limits.planId;
  if (limits.planName) info.planName = limits.planName;
  if (limits.periodEnd) info.periodEnd = limits.periodEnd;
  // Кредиты показываем, когда кап считается из них (не-BYO, либо BYO без прокси — там работают только пакеты).
  if (!limits.byoKey || limits.note) {
    const quota = Math.round(((limits.quotaMicro + limits.creditsMicro + limits.creditsConsumedMicro + limits.overageMicro) / 1e6) * rubPerUsd);
    const used = Math.round(snap.spent * rubPerUsd);
    // Единица и пояснение: голое «использовано 371 из 850» после оплаты 900 ₽ читается как обман
    // (живой прогон 2026-09-02). Кредит = единица расхода на модель по курсу периода.
    info.credits = {
      quota, used, remaining: Math.max(0, quota - used), pct: quota > 0 ? Math.round((used / quota) * 100) : used > 0 ? 100 : 0,
      unit: "₽", note: "1 кредит ≈ 1 ₽ работы модели",
    };
  }
  return info;
}

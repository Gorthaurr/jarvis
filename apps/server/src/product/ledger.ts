/**
 * Ledger расхода (таблица `usage_ledger`, миграция 0104) — АВТОРИТЕТ по тратам продукта (план §3): одна
 * строка на раунд/вызов, стоимость в МИКРО-долларах (integer) — никакого округления до цента на раунд
 * (дефект usage_quota.cost_estimate NUMERIC(12,2): −19% на раунде $0,012). Агрегат периода — usage_quota
 * (cost_micro/tokens_used/tts_chars_used) обновляется тем же вызовом: одна запись = обе таблицы согласованы.
 *
 * ⚠️ SpendGuard.persistUsage тоже прибавляет tokens_used/cost_estimate в usage_quota. В продуктовом режиме
 * писатель токенов один — этот; проводка (кто зовёт recordLedger и глушит ли persist гварда) — за gateway.
 */
import { ProductError, int, iso, num, q } from "./db.js";

export type LedgerKind = "llm" | "stt" | "tts";
export type LedgerChannel = "node" | "proxy" | "brain";

export interface LedgerUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface LedgerEntry {
  userId: string;
  ts?: number;
  taskId?: string;
  round?: number;
  kind: LedgerKind;
  model?: string;
  usage?: LedgerUsage;
  sttSeconds?: number;
  ttsChars?: number;
  /** Целые микро-доллары (obs/pricing.costMicroUsd). */
  costMicro: number;
  channel: LedgerChannel;
  /** usage не пришёл (обрыв стрима) — оценка вверх. */
  estimated?: boolean;
  ok?: boolean;
}

/** 'YYYY-MM' по UTC — та же формула, что у SpendGuard.currentPeriod (иначе на границе месяца строки разъехались бы). */
export function periodOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

const tok = (v: number | undefined): number => (Number.isFinite(v) ? Math.max(0, Math.trunc(v as number)) : 0);

export async function recordLedger(e: LedgerEntry): Promise<{ id: number; period: string }> {
  if (!Number.isFinite(e.costMicro) || e.costMicro < 0) {
    throw new ProductError("invalid_input", `costMicro должен быть конечным числом ≥ 0, получено ${String(e.costMicro)}`);
  }
  const costMicro = Math.round(e.costMicro);
  const ts = e.ts ?? Date.now();
  const period = periodOf(ts);
  const u = e.usage ?? {};
  const tokens = [tok(u.inputTokens), tok(u.outputTokens), tok(u.cacheReadTokens), tok(u.cacheCreationTokens)];
  const ttsChars = tok(e.ttsChars);
  const rows = await q<{ id: unknown }>(
    `insert into usage_ledger (user_id, ts, period, task_id, round, kind, model, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, stt_seconds, tts_chars, cost_micro, channel, estimated, ok)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
    [
      e.userId, iso(ts), period, e.taskId ?? null, Number.isInteger(e.round) ? e.round : null, e.kind, e.model ?? null,
      tokens[0], tokens[1], tokens[2], tokens[3], Number.isFinite(e.sttSeconds) ? e.sttSeconds : 0, ttsChars, costMicro,
      e.channel, e.estimated === true, e.ok ?? null,
    ],
  );
  await q(
    // tokens_used НЕ трогаем: его уже прибавляет SpendGuard.persistUsage на том же вызове (иначе двойной счёт).
    `insert into usage_quota (user_id, period, cost_micro, tts_chars_used)
     values ($1,$2,$3,$4)
     on conflict (user_id, period) do update set
       cost_micro = usage_quota.cost_micro + excluded.cost_micro,
       tts_chars_used = usage_quota.tts_chars_used + excluded.tts_chars_used,
       updated_at = now()`,
    [e.userId, period, costMicro, ttsChars],
  );
  return { id: int(rows[0]?.id), period };
}

export interface LedgerSummary {
  period: string;
  costMicro: number;
  calls: number;
  byModel: Array<{ model: string; calls: number; costMicro: number }>;
  byKind: Array<{ kind: LedgerKind; calls: number; costMicro: number }>;
}

export async function ledgerSummary(userId: string, period: string): Promise<LedgerSummary> {
  type Agg = { model?: unknown; kind?: unknown; calls: unknown; cost_micro: unknown };
  const byModel = await q<Agg>(
    "select coalesce(model, '') as model, count(*)::int as calls, coalesce(sum(cost_micro), 0) as cost_micro from usage_ledger where user_id = $1 and period = $2 group by model order by cost_micro desc",
    [userId, period],
  );
  const byKind = await q<Agg>(
    "select kind, count(*)::int as calls, coalesce(sum(cost_micro), 0) as cost_micro from usage_ledger where user_id = $1 and period = $2 group by kind order by cost_micro desc",
    [userId, period],
  );
  return {
    period,
    costMicro: byKind.reduce((a, r) => a + int(r.cost_micro), 0),
    calls: byKind.reduce((a, r) => a + num(r.calls), 0),
    byModel: byModel.map((r) => ({ model: String(r.model), calls: num(r.calls), costMicro: int(r.cost_micro) })),
    byKind: byKind.map((r) => ({ kind: String(r.kind) as LedgerKind, calls: num(r.calls), costMicro: int(r.cost_micro) })),
  };
}

export interface TaskCost {
  taskId: string;
  calls: number;
  costMicro: number;
  firstTs: number;
  lastTs: number;
}

/** Самые дорогие задачи периода (для вкладки «Оплата»: «топ-5 дорогих задач месяца»). */
export async function topTasks(userId: string, period: string, n = 5): Promise<TaskCost[]> {
  const rows = await q<Record<string, unknown>>(
    `select task_id, count(*)::int as calls, coalesce(sum(cost_micro), 0) as cost_micro, min(ts) as first_ts, max(ts) as last_ts
       from usage_ledger where user_id = $1 and period = $2 and task_id is not null
      group by task_id order by cost_micro desc limit $3`,
    [userId, period, Math.max(1, Math.trunc(n))],
  );
  return rows.map((r) => ({
    taskId: String(r.task_id), calls: num(r.calls), costMicro: int(r.cost_micro),
    firstTs: new Date(r.first_ts as string | Date).getTime(), lastTs: new Date(r.last_ts as string | Date).getTime(),
  }));
}

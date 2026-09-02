/**
 * Кредиты мозга проекта (таблица `credit_grants`, миграция 0102): пакеты (pack), выдача админом, триал,
 * возвраты. Не сгорают в конце месяца (expires_at NULL), списываются FIFO по дате выдачи. Единица —
 * МИКРО-доллары (integer); «кредиты» пользователю показывает QuotaResolver по курсу периода.
 *
 * Возврат — ОТРИЦАТЕЛЬНЫЙ грант (source='refund'): баланс честно уходит в минус, если пакет уже частично
 * потрачен, а не «исчезает» молча; списание из отрицательного гранта невозможно (remaining ≤ 0 не выбирается).
 */
import { ensureUser } from "../db/users.js";
import { ProductError, int, iso, ms, one, q } from "./db.js";

export type GrantSource = "pack" | "admin" | "trial" | "refund";

export interface CreditGrant {
  id: string;
  userId: string;
  source: GrantSource;
  planId: string | null;
  amountMicro: number;
  remainingMicro: number;
  expiresAt: number | null;
  note: string | null;
  createdAt: number;
}

const COLS = "id, user_id, source, plan_id, amount_micro, remaining_micro, expires_at, note, created_at";
type Row = Record<string, unknown>;

function rowToGrant(r: Row): CreditGrant {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    source: String(r.source) as GrantSource,
    planId: r.plan_id == null ? null : String(r.plan_id),
    amountMicro: int(r.amount_micro),
    remainingMicro: int(r.remaining_micro),
    expiresAt: ms(r.expires_at),
    note: r.note == null ? null : String(r.note),
    createdAt: ms(r.created_at) ?? 0,
  };
}

export interface GrantInput {
  userId: string;
  source: GrantSource;
  planId?: string;
  amountMicro: number;
  expiresAt?: number | null;
  note?: string;
}

export async function grantCredits(g: GrantInput): Promise<CreditGrant> {
  if (!Number.isInteger(g.amountMicro) || g.amountMicro === 0) {
    throw new ProductError("invalid_input", `amountMicro гранта — ненулевое целое, получено ${String(g.amountMicro)}`);
  }
  if (g.amountMicro < 0 && g.source !== "refund" && g.source !== "admin") {
    throw new ProductError("invalid_input", `отрицательный грант допустим только для refund/admin, не ${g.source}`);
  }
  await ensureUser(g.userId);
  const rows = await q<Row>(
    `insert into credit_grants (user_id, source, plan_id, amount_micro, remaining_micro, expires_at, note)
     values ($1,$2,$3,$4,$4,$5,$6) returning ${COLS}`,
    [g.userId, g.source, g.planId ?? null, g.amountMicro, g.expiresAt == null ? null : iso(g.expiresAt), g.note ?? null],
  );
  return rowToGrant(one(rows, "credit_grants insert"));
}

export async function listGrants(userId: string): Promise<CreditGrant[]> {
  const rows = await q<Row>(`select ${COLS} from credit_grants where user_id = $1 order by created_at, id`, [userId]);
  return rows.map(rowToGrant);
}

/** Сумма remaining по неистёкшим грантам (может быть отрицательной после возврата). */
export async function creditBalanceMicro(userId: string, now: number): Promise<number> {
  const rows = await q<{ total: unknown }>(
    "select coalesce(sum(remaining_micro), 0) as total from credit_grants where user_id = $1 and (expires_at is null or expires_at > $2)",
    [userId, iso(now)],
  );
  return int(rows[0]?.total);
}

/**
 * Списать `amountMicro` FIFO по неистёкшим грантам с положительным остатком. Возвращает, сколько реально
 * списано и сколько не хватило — вызывающий решает, что делать с недостачей (квота плана/овердрафт/отказ).
 * Каждый грант уменьшается атомарным UPDATE с проверкой остатка: параллельное списание не уводит в минус.
 */
export async function consumeCredits(userId: string, amountMicro: number, now: number): Promise<{ consumed: number; shortfall: number }> {
  if (!Number.isInteger(amountMicro) || amountMicro < 0) {
    throw new ProductError("invalid_input", `amountMicro списания — целое ≥ 0, получено ${String(amountMicro)}`);
  }
  let need = amountMicro;
  if (need === 0) return { consumed: 0, shortfall: 0 };
  const grants = await q<Row>(
    `select id, remaining_micro from credit_grants
      where user_id = $1 and remaining_micro > 0 and (expires_at is null or expires_at > $2)
      order by created_at, id`,
    [userId, iso(now)],
  );
  for (const g of grants) {
    if (need <= 0) break;
    const take = Math.min(need, int(g.remaining_micro));
    const done = await q<{ id: string }>(
      "update credit_grants set remaining_micro = remaining_micro - $2 where id = $1 and remaining_micro >= $2 returning id",
      [g.id, take],
    );
    if (done.length > 0) need -= take;
  }
  return { consumed: amountMicro - need, shortfall: need };
}

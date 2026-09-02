/**
 * Отчёты «подписки» и «выручка»: состав по статусам/планам, MRR, истекающие триалы, просрочка, отток;
 * платежи и возвраты по дням/планам, инвойсы в ожидании. Деньги — в минимальных единицах валюты в БД,
 * в отчёте — в основных (копейки → рубли); MRR считается только по живым подпискам kind='subscription'.
 */
import { query } from "../../db/pool.js";
import { type Report, minorToMajor, unavailable } from "./types.js";

type Row = Record<string, unknown>;
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const iso = (ms: number): string => new Date(ms).toISOString();

export async function subscriptionsReport(now = Date.now()): Promise<Report> {
  const name = "subscriptions";
  const title = "Подписки";
  const byStatus = await query<Row>(
    `select s.status, s.plan_id, p.name as plan_name, p.currency, count(*)::int as n, sum(p.price_minor)::bigint as sum_minor
       from subscriptions s join plans p on p.id = s.plan_id
      group by s.status, s.plan_id, p.name, p.currency order by s.status, s.plan_id`,
  );
  if (!byStatus) return unavailable(name, title, "БД недоступна или нет продуктовых таблиц", now);
  const d7 = iso(now + 7 * 86_400_000);
  const d30 = iso(now - 30 * 86_400_000);
  const live = await query<Row>(
    `select p.currency,
            sum(p.price_minor) filter (where s.status = 'active' and p.kind = 'subscription' and s.source = 'payment')::bigint as mrr_minor,
            sum(p.price_minor) filter (where s.status in ('active','trialing') and p.kind = 'subscription' and s.source <> 'payment')::bigint as free_minor,
            count(*) filter (where s.status = 'trialing' and s.trial_end <= $1)::int as trials_expiring7,
            count(*) filter (where s.status = 'past_due')::int as past_due,
            count(*) filter (where s.status in ('canceled','expired') and s.updated_at >= $2)::int as churn30,
            count(*) filter (where s.status in ('active','trialing','past_due'))::int as live_total
       from subscriptions s join plans p on p.id = s.plan_id group by p.currency`,
    [d7, d30],
  );
  const kpi: Record<string, number | string | null> = {};
  for (const r of live?.rows ?? []) {
    const cur = String(r.currency);
    kpi[`MRR (${cur})`] = minorToMajor(r.mrr_minor); // только оплаченные (source=payment): гранты/триалы — не выручка
    kpi[`выдано бесплатно, эквивалент (${cur})`] = minorToMajor(r.free_minor);
    kpi["живых подписок"] = n(r.live_total) + n(kpi["живых подписок"]);
    kpi["триалов истекает за 7 дн"] = n(r.trials_expiring7) + n(kpi["триалов истекает за 7 дн"]);
    kpi["ждут оплаты (past_due)"] = n(r.past_due) + n(kpi["ждут оплаты (past_due)"]);
    kpi["отток за 30 дн (canceled+expired)"] = n(r.churn30) + n(kpi["отток за 30 дн (canceled+expired)"]);
  }
  return {
    name,
    title,
    generatedAt: iso(now),
    available: true,
    kpi,
    tables: [
      {
        title: "По статусу и плану",
        columns: ["Статус", "План", "Название", "Подписок", "Сумма цен (осн. ед.)", "Валюта"],
        rows: byStatus.rows.map((r) => [String(r.status), String(r.plan_id), String(r.plan_name), n(r.n), minorToMajor(r.sum_minor), String(r.currency)]),
        note: "MRR = сумма цен живых (active+trialing) месячных планов; пакеты в MRR не входят",
      },
    ],
  };
}

export async function revenueReport(opts: { from?: number; to?: number; now?: number } = {}): Promise<Report> {
  const now = opts.now ?? Date.now();
  const name = "revenue";
  const title = "Выручка и платежи";
  const from = iso(opts.from ?? now - 30 * 86_400_000);
  const to = iso(opts.to ?? now);
  const byDay = await query<Row>(
    `select to_char(created_at, 'YYYY-MM-DD') as day, currency, status, count(*)::int as n, sum(amount_minor)::bigint as sum_minor
       from payments where created_at >= $1 and created_at < $2
      group by day, currency, status order by day`,
    [from, to],
  );
  if (!byDay) return unavailable(name, title, "БД недоступна или нет продуктовых таблиц", now);
  const byPlan = await query<Row>(
    `select i.plan_id, i.currency, count(*)::int as n, sum(p.amount_minor)::bigint as sum_minor
       from payments p join invoices i on i.id = p.invoice_id
      where p.status = 'succeeded' and p.created_at >= $1 and p.created_at < $2
      group by i.plan_id, i.currency order by sum_minor desc`,
    [from, to],
  );
  const invoices = await query<Row>(
    `select status, count(*)::int as n, sum(amount_minor)::bigint as sum_minor from invoices
      where created_at >= $1 and created_at < $2 group by status order by status`,
    [from, to],
  );
  const succeeded = byDay.rows.filter((r) => r.status === "succeeded").reduce((a, r) => a + n(r.sum_minor), 0);
  const refunded = byDay.rows.filter((r) => r.status === "refunded").reduce((a, r) => a + n(r.sum_minor), 0);
  return {
    name,
    title,
    generatedAt: iso(now),
    available: true,
    kpi: {
      "период": `${from.slice(0, 10)} … ${to.slice(0, 10)}`,
      "оплачено (осн. ед.)": minorToMajor(succeeded),
      "возвраты (осн. ед.)": minorToMajor(refunded),
      "нетто": minorToMajor(succeeded - refunded),
      "успешных платежей": byDay.rows.filter((r) => r.status === "succeeded").reduce((a, r) => a + n(r.n), 0),
    },
    tables: [
      { title: "Платежи по дням", columns: ["День", "Валюта", "Статус", "Платежей", "Сумма"], rows: byDay.rows.map((r) => [String(r.day), String(r.currency), String(r.status), n(r.n), minorToMajor(r.sum_minor)]) },
      { title: "Оплачено по планам", columns: ["План", "Валюта", "Платежей", "Сумма"], rows: (byPlan?.rows ?? []).map((r) => [String(r.plan_id), String(r.currency), n(r.n), minorToMajor(r.sum_minor)]) },
      { title: "Инвойсы по статусу", columns: ["Статус", "Инвойсов", "Сумма"], rows: (invoices?.rows ?? []).map((r) => [String(r.status), n(r.n), minorToMajor(r.sum_minor)]) },
    ],
  };
}

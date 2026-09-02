/**
 * Отчёты «расход/COGS», «модели», «квоты», «удержание»: что стоят пользователи по ledger (µ$ → $),
 * доля моделей, кто у потолка, сколько дней в месяце люди реально пользуются.
 * COGS считается по usage_ledger (точные микро-доллары per round), выручка — по цене живого плана;
 * маржа по плану = (цена в $ по курсу − COGS) / цена. Курс — параметр (JARVIS_RUB_PER_USD, деф 85).
 */
import { query } from "../../db/pool.js";
import { type Report, microToUsd, minorToMajor, periodOf, unavailable } from "./types.js";

type Row = Record<string, unknown>;
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const iso = (ms: number): string => new Date(ms).toISOString();

export function rubPerUsd(): number {
  const v = Number.parseFloat(process.env.JARVIS_RUB_PER_USD ?? "85");
  return Number.isFinite(v) && v > 0 ? v : 85;
}

export async function usageReport(opts: { period?: string; now?: number; top?: number } = {}): Promise<Report> {
  const now = opts.now ?? Date.now();
  const period = opts.period ?? periodOf(now);
  const name = "usage";
  const title = `Расход и COGS за ${period}`;
  const perUser = await query<Row>(
    `select l.user_id, count(*)::int as calls, sum(l.cost_micro)::bigint as cost_micro,
            sum(l.input_tokens + l.output_tokens + l.cache_read_tokens + l.cache_write_tokens)::bigint as tokens,
            count(distinct l.task_id)::int as tasks,
            s.plan_id, p.price_minor, p.currency
       from usage_ledger l
       left join subscriptions s on s.user_id = l.user_id and s.status in ('active','trialing','past_due')
       left join plans p on p.id = s.plan_id
      where l.period = $1
      group by l.user_id, s.plan_id, p.price_minor, p.currency
      order by cost_micro desc`,
    [period],
  );
  if (!perUser) return unavailable(name, title, "БД недоступна или нет продуктовых таблиц", now);
  const total = await query<Row>(
    `select count(*)::int as calls, coalesce(sum(cost_micro),0)::bigint as cost_micro, count(distinct user_id)::int as users,
            coalesce(max(cost_micro),0)::bigint as max_call
       from usage_ledger where period = $1`,
    [period],
  );
  const fx = rubPerUsd();
  const t = total?.rows[0] ?? {};
  const top = opts.top ?? 20;
  const rows = perUser.rows.slice(0, top).map((r) => {
    const cogs = microToUsd(r.cost_micro);
    const priceMajor = minorToMajor(r.price_minor);
    const priceUsd = r.currency === "RUB" ? priceMajor / fx : priceMajor;
    const margin = priceUsd > 0 ? Math.round(((priceUsd - cogs) / priceUsd) * 1000) / 10 : null;
    return [String(r.user_id), r.plan_id ? String(r.plan_id) : "—", n(r.tasks), n(r.calls), n(r.tokens), cogs, priceUsd > 0 ? Math.round(priceUsd * 100) / 100 : null, margin];
  });
  const byPlan = new Map<string, { users: number; cogs: number; revenueUsd: number }>();
  for (const r of perUser.rows) {
    const key = r.plan_id ? String(r.plan_id) : "без плана";
    const e = byPlan.get(key) ?? { users: 0, cogs: 0, revenueUsd: 0 };
    e.users += 1;
    e.cogs += microToUsd(r.cost_micro);
    const priceMajor = minorToMajor(r.price_minor);
    e.revenueUsd += r.currency === "RUB" ? priceMajor / fx : priceMajor;
    byPlan.set(key, e);
  }
  return {
    name,
    title,
    generatedAt: iso(now),
    available: true,
    kpi: {
      "период": period,
      "пользователей с расходом": n(t.users),
      "вызовов": n(t.calls),
      "COGS всего, $": microToUsd(t.cost_micro),
      "COGS на пользователя, $": n(t.users) > 0 ? Math.round((microToUsd(t.cost_micro) / n(t.users)) * 100) / 100 : 0,
      "самый дорогой вызов, $": microToUsd(t.max_call),
      "курс ₽/$ (JARVIS_RUB_PER_USD)": fx,
    },
    tables: [
      { title: `Топ-${top} пользователей по расходу`, columns: ["userId", "План", "Задач", "Вызовов", "Токенов", "COGS $", "Цена плана $", "Маржа %"], rows, note: "маржа = (цена плана − COGS)/цена; пакеты кредитов в цену не входят" },
      { title: "По планам", columns: ["План", "Пользователей", "COGS $", "Выручка $ (цены планов)", "Маржа %"], rows: [...byPlan.entries()].map(([k, e]) => [k, e.users, Math.round(e.cogs * 100) / 100, Math.round(e.revenueUsd * 100) / 100, e.revenueUsd > 0 ? Math.round(((e.revenueUsd - e.cogs) / e.revenueUsd) * 1000) / 10 : null]) },
    ],
  };
}

export async function modelsReport(opts: { period?: string; now?: number } = {}): Promise<Report> {
  const now = opts.now ?? Date.now();
  const period = opts.period ?? periodOf(now);
  const name = "models";
  const title = `Модели за ${period}`;
  const rows = await query<Row>(
    `select coalesce(model, '(нет)') as model, kind, count(*)::int as calls, sum(cost_micro)::bigint as cost_micro,
            sum(input_tokens)::bigint as in_t, sum(output_tokens)::bigint as out_t, sum(cache_read_tokens)::bigint as cr, sum(cache_write_tokens)::bigint as cw,
            count(distinct user_id)::int as users
       from usage_ledger where period = $1 group by model, kind order by cost_micro desc`,
    [period],
  );
  if (!rows) return unavailable(name, title, "БД недоступна или нет продуктовых таблиц", now);
  const totalMicro = rows.rows.reduce((a, r) => a + n(r.cost_micro), 0);
  return {
    name,
    title,
    generatedAt: iso(now),
    available: true,
    kpi: { "период": period, "COGS всего, $": microToUsd(totalMicro), "моделей": rows.rows.length },
    tables: [{
      title: "Доля по моделям",
      columns: ["Модель", "Вид", "Вызовов", "Пользователей", "COGS $", "Доля %", "in", "out", "cache read", "cache write"],
      rows: rows.rows.map((r) => [String(r.model), String(r.kind), n(r.calls), n(r.users), microToUsd(r.cost_micro), totalMicro > 0 ? Math.round((n(r.cost_micro) / totalMicro) * 1000) / 10 : 0, n(r.in_t), n(r.out_t), n(r.cr), n(r.cw)]),
      note: "cache write — главный рычаг экономики (холодная перезапись префикса); смотри долю",
    }],
  };
}

export async function quotaReport(opts: { period?: string; now?: number } = {}): Promise<Report> {
  const now = opts.now ?? Date.now();
  const period = opts.period ?? periodOf(now);
  const name = "quota";
  const title = `Квоты за ${period}`;
  const rows = await query<Row>(
    `select user_id, cost_micro, llm_quota_micro, cap_micro, warned_80_at, warned_100_at, kill_switch, quota_source
       from usage_quota where period = $1 order by cost_micro desc`,
    [period],
  );
  if (!rows) return unavailable(name, title, "БД недоступна или нет продуктовых таблиц", now);
  // % — от ПОЛНОГО капа периода (квота + кредиты, usage_quota.cap_micro), как в usage.info; без cap_micro — от квоты плана.
  const capOf = (r: Row): number => (n(r.cap_micro) > 0 ? n(r.cap_micro) : n(r.llm_quota_micro));
  const pct = (r: Row): number | null => (capOf(r) > 0 ? Math.round((n(r.cost_micro) / capOf(r)) * 1000) / 10 : null);
  const over = rows.rows.filter((r) => (pct(r) ?? 0) >= 100).length;
  const near = rows.rows.filter((r) => { const p = pct(r); return p !== null && p >= 80 && p < 100; }).length;
  return {
    name,
    title,
    generatedAt: iso(now),
    available: true,
    kpi: { "период": period, "у потолка (≥80%)": near, "исчерпали (≥100%)": over, "kill-switch": rows.rows.filter((r) => r.kill_switch === true).length },
    tables: [{
      title: "Пользователи по доле квоты",
      columns: ["userId", "Использовано $", "Потолок $ (план+кредиты)", "Квота плана $", "%", "Предупр. 80", "Предупр. 100", "Стоп", "Источник"],
      // Процент считается от ПОЛНОГО потолка — колонка обязана показывать его же, иначе строка сама себе
      // противоречит («21.5 из 8 = 84.5%», живой прогон 2026-09-02); квота плана остаётся отдельной колонкой.
      rows: rows.rows.map((r) => [String(r.user_id), microToUsd(r.cost_micro), capOf(r) > 0 ? microToUsd(capOf(r)) : null, r.llm_quota_micro === null ? null : microToUsd(r.llm_quota_micro), pct(r), r.warned_80_at ? "да" : "", r.warned_100_at ? "да" : "", r.kill_switch ? "да" : "", r.quota_source ? String(r.quota_source) : "—"]),
    }],
  };
}

export async function retentionReport(opts: { now?: number; days?: number } = {}): Promise<Report> {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 30;
  const name = "retention";
  const title = `Удержание за ${days} дн`;
  const since = iso(now - days * 86_400_000);
  const rows = await query<Row>(
    `select user_id, count(distinct to_char(ts, 'YYYY-MM-DD'))::int as active_days, min(ts) as first_ts, max(ts) as last_ts
       from usage_ledger where ts >= $1 group by user_id order by active_days desc`,
    [since],
  );
  if (!rows) return unavailable(name, title, "БД недоступна или нет продуктовых таблиц", now);
  const cohorts = await query<Row>(
    `select to_char(u.created_at, 'YYYY-MM') as cohort, count(*)::int as users,
            count(*) filter (where exists (select 1 from usage_ledger l where l.user_id = u.id and l.ts >= $1))::int as active
       from users u group by cohort order by cohort`,
    [since],
  );
  const dist = new Map<string, number>();
  for (const r of rows.rows) {
    const d = n(r.active_days);
    const bucket = d >= 20 ? "20+" : d >= 10 ? "10–19" : d >= 5 ? "5–9" : d >= 2 ? "2–4" : "1";
    dist.set(bucket, (dist.get(bucket) ?? 0) + 1);
  }
  return {
    name,
    title,
    generatedAt: iso(now),
    available: true,
    kpi: { "активных пользователей": rows.rows.length, "среднее активных дней": rows.rows.length ? Math.round((rows.rows.reduce((a, r) => a + n(r.active_days), 0) / rows.rows.length) * 10) / 10 : 0 },
    tables: [
      { title: "Распределение по активным дням", columns: ["Дней", "Пользователей"], rows: ["1", "2–4", "5–9", "10–19", "20+"].map((b) => [b, dist.get(b) ?? 0]) },
      { title: "Когорты по месяцу регистрации", columns: ["Когорта", "Пользователей", "Активны в окне"], rows: (cohorts?.rows ?? []).map((r) => [String(r.cohort), n(r.users), n(r.active)]) },
    ],
  };
}

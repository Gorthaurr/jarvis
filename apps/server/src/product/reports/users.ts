/**
 * Отчёты «пользователи» и «данные» продукта: состав аккаунтов, новые/активные, ожидающие удаления;
 * объёмы таблиц (что вообще накоплено). Активность — по usage_ledger (реальные вызовы), не по логинам.
 */
import { query } from "../../db/pool.js";
import { type Report, type ReportTable, unavailable } from "./types.js";

type Row = Record<string, unknown>;
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function usersReport(now = Date.now()): Promise<Report> {
  const name = "users";
  const title = "Пользователи";
  const byStatus = await query<Row>("select status, role, count(*)::int as n from users group by status, role order by status, role");
  if (!byStatus) return unavailable(name, title, "БД недоступна", now);
  const iso = (ms: number): string => new Date(ms).toISOString();
  const d7 = iso(now - 7 * 86_400_000);
  const d30 = iso(now - 30 * 86_400_000);
  const totals = await query<Row>(
    `select count(*)::int as total,
            count(*) filter (where created_at >= $1)::int as new7,
            count(*) filter (where created_at >= $2)::int as new30,
            count(*) filter (where status = 'deleted')::int as deleted
       from users`,
    [d7, d30],
  );
  const active = await query<Row>(
    `select count(distinct user_id) filter (where ts >= $1)::int as active7,
            count(distinct user_id) filter (where ts >= $2)::int as active30
       from usage_ledger`,
    [d7, d30],
  );
  const pendingPurge = await query<Row>("select count(*)::int as n from deletion_requests where done_at is null");
  const t = totals?.rows[0] ?? {};
  const a = active?.rows[0] ?? {};
  const statusTable: ReportTable = {
    title: "По статусу и роли",
    columns: ["Статус", "Роль", "Пользователей"],
    rows: byStatus.rows.map((r) => [String(r.status), String(r.role), n(r.n)]),
  };
  return {
    name,
    title,
    generatedAt: iso(now),
    available: true,
    kpi: {
      "всего": n(t.total),
      "новых за 7 дн": n(t.new7),
      "новых за 30 дн": n(t.new30),
      "активных за 7 дн (были вызовы)": n(a.active7),
      "активных за 30 дн": n(a.active30),
      "удалённых": n(t.deleted),
      "ждут окончательного удаления": n(pendingPurge?.rows[0]?.n),
    },
    tables: [statusTable],
  };
}

/** Объёмы данных: сколько строк в каждой таблице продукта и памяти (что накоплено, что чистить). */
export async function dataReport(now = Date.now()): Promise<Report> {
  const name = "data";
  const title = "Объёмы данных";
  const tables = [
    "users", "auth_tokens", "devices", "auth_challenges", "deletion_requests",
    "plans", "subscriptions", "credit_grants", "invoices", "payments", "webhook_events",
    "usage_quota", "usage_ledger", "episodic_memory", "skills", "tasks", "action_log",
  ];
  const rows: Array<Array<string | number | null>> = [];
  let any = false;
  for (const t of tables) {
    // Имя таблицы — из фиксированного списка выше, не из входа.
    const r = await query<Row>(`select count(*)::int as n from ${t}`);
    if (r === null) {
      // null = нет БД ИЛИ таблицы нет (query глотает ошибку): различаем по первой таблице users.
      if (t === "users") return unavailable(name, title, "БД недоступна", now);
      rows.push([t, null]);
      continue;
    }
    any = true;
    rows.push([t, n(r.rows[0]?.n)]);
  }
  if (!any) return unavailable(name, title, "ни одна таблица не ответила", now);
  return {
    name,
    title,
    generatedAt: new Date(now).toISOString(),
    available: true,
    kpi: { "таблиц": tables.length, "таблиц без ответа (нет миграции?)": rows.filter((r) => r[1] === null).length },
    tables: [{ title: "Строк по таблицам", columns: ["Таблица", "Строк"], rows, note: "— = таблица не ответила (продуктовые миграции не применены или нет прав)" }],
  };
}

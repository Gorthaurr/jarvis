/**
 * Реестр отчётов продукта: имя → функция. Один вход для HTTP (/v1/admin/reports/:name), /cogs и CLI.
 * Сводка (`overview`) собирает KPI всех отчётов — «одним экраном».
 */
import { dataReport, usersReport } from "./users.js";
import { revenueReport, subscriptionsReport } from "./subscriptions.js";
import { modelsReport, quotaReport, retentionReport, usageReport } from "./usage.js";
import { type Report, renderReportMarkdown } from "./types.js";

export type { Report, ReportTable } from "./types.js";
export { renderReportMarkdown } from "./types.js";

export interface ReportParams {
  period?: string;
  from?: number;
  to?: number;
  days?: number;
  top?: number;
  now?: number;
}

type ReportFn = (p: ReportParams) => Promise<Report>;

export const REPORTS: Record<string, { title: string; run: ReportFn }> = {
  users: { title: "Пользователи", run: (p) => usersReport(p.now) },
  subscriptions: { title: "Подписки", run: (p) => subscriptionsReport(p.now) },
  revenue: { title: "Выручка и платежи", run: (p) => revenueReport(p) },
  usage: { title: "Расход и COGS", run: (p) => usageReport(p) },
  models: { title: "Модели", run: (p) => modelsReport(p) },
  quota: { title: "Квоты", run: (p) => quotaReport(p) },
  retention: { title: "Удержание", run: (p) => retentionReport(p) },
  data: { title: "Объёмы данных", run: (p) => dataReport(p.now) },
};

export function listReports(): Array<{ name: string; title: string }> {
  return Object.entries(REPORTS).map(([name, r]) => ({ name, title: r.title }));
}

export async function runReport(name: string, params: ReportParams = {}): Promise<Report | null> {
  const r = REPORTS[name];
  return r ? r.run(params) : null;
}

/** Сводка: KPI всех отчётов в одном объекте (таблицы не включаем — для «одним экраном»). */
export async function overviewReport(params: ReportParams = {}): Promise<Report> {
  const now = params.now ?? Date.now();
  const parts = await Promise.all(Object.keys(REPORTS).map((k) => runReport(k, params)));
  const kpi: Record<string, number | string | null> = {};
  const missing: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (!p.available) { missing.push(`${p.name}: ${p.reason ?? "?"}`); continue; }
    for (const [k, v] of Object.entries(p.kpi)) kpi[`${p.title} · ${k}`] = v;
  }
  return {
    name: "overview",
    title: "Сводка продукта",
    generatedAt: new Date(now).toISOString(),
    available: parts.some((p) => p?.available),
    ...(missing.length ? { reason: `недоступны: ${missing.join("; ")}` } : {}),
    kpi,
    tables: [],
  };
}

export async function renderReport(name: string, params: ReportParams = {}): Promise<string | null> {
  const r = name === "overview" ? await overviewReport(params) : await runReport(name, params);
  return r ? renderReportMarkdown(r) : null;
}

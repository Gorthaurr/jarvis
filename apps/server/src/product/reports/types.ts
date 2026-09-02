/**
 * ОТЧЁТЫ ПРОДУКТА (2026-09-02, требование владельца: «все виды отчётов по данным, подпискам,
 * пользователям и прочее») — общие типы и рендер в markdown.
 *
 * Принципы: (1) отчёт — чистая функция над БД, без побочных эффектов; (2) ЧЕСТНОСТЬ: без БД отчёт
 * возвращает `available:false` с причиной, а не пустые нули (ноль пользователей ≠ «БД не подключена»);
 * (3) одна таблица = один `ReportTable`, чтобы HTTP/CLI/панель рендерили одинаково.
 */

export interface ReportTable {
  title: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  /** Примечание под таблицей (допущения, единицы). */
  note?: string;
}

export interface Report {
  name: string;
  title: string;
  generatedAt: string;
  available: boolean;
  /** Почему недоступен (нет БД / нет продуктовых таблиц). */
  reason?: string;
  /** Ключевые числа для сводки. */
  kpi: Record<string, number | string | null>;
  tables: ReportTable[];
}

export function unavailable(name: string, title: string, reason: string, now: number): Report {
  return { name, title, generatedAt: new Date(now).toISOString(), available: false, reason, kpi: {}, tables: [] };
}

/** 'YYYY-MM' периода учёта (совпадает с SpendGuard.currentPeriod). */
export function periodOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

/** Микро-доллары → доллары с 4 знаками (для таблиц). Вход — сырое значение строки БД (unknown). */
export function microToUsd(micro: unknown): number {
  const n = Number(micro ?? 0);
  return Number.isFinite(n) ? Math.round(n / 100) / 10_000 : 0;
}

/** Копейки → рубли/валюта с 2 знаками. Вход — сырое значение строки БД (unknown). */
export function minorToMajor(minor: unknown): number {
  const n = Number(minor ?? 0);
  return Number.isFinite(n) ? Math.round(n) / 100 : 0;
}

const esc = (v: string | number | null): string => (v === null || v === undefined ? "—" : String(v).replace(/\|/g, "\\|"));

/** Markdown-рендер одного отчёта (заголовок, KPI, таблицы). */
export function renderReportMarkdown(r: Report): string {
  const out: string[] = [`# ${r.title}`, ``, `Сформирован: ${r.generatedAt}`];
  if (!r.available) {
    out.push(``, `**Недоступен:** ${r.reason ?? "неизвестная причина"}`);
    return out.join("\n");
  }
  const kpi = Object.entries(r.kpi);
  if (kpi.length) {
    out.push(``, `## Ключевые числа`, ``);
    for (const [k, v] of kpi) out.push(`- **${k}**: ${esc(v)}`);
  }
  for (const t of r.tables) {
    out.push(``, `## ${t.title}`, ``);
    out.push(`| ${t.columns.join(" | ")} |`, `|${t.columns.map(() => "---").join("|")}|`);
    for (const row of t.rows) out.push(`| ${row.map(esc).join(" | ")} |`);
    if (t.note) out.push(``, `_${t.note}_`);
    if (t.rows.length === 0) out.push(``, `_нет строк_`);
  }
  return out.join("\n");
}

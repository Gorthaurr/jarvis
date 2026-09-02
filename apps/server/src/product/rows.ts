/**
 * Маппинг значений строк БД для продуктовых модулей. pg отдаёт TIMESTAMPTZ как Date, PGlite — тоже,
 * но контракт QueryClient этого не обещает — страхуемся от строки. В обратную сторону время отдаём
 * ISO-строкой: сериализация Date у двух бэкендов различается, строка однозначна для обоих.
 */
export function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Момент времени как параметр запроса (timestamptz). */
export function ts(d: Date): string {
  return d.toISOString();
}

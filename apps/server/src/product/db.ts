/**
 * Общий доступ продуктовых модулей (планы/подписки/кредиты/оплата/ledger/квоты) к БД.
 *
 * Зачем прослойка: `query()` пула отдаёт null И при отсутствии БД, И при SQL-ошибке (она уже в логе db).
 * Для дев-режима владельца это штатная деградация «работаем без БД». Для продукта молчаливый null означал
 * бы «подписки нет» / «оплата не пришла» / «квота 0» — ложь, которую пользователь прочитает как факт.
 * Поэтому здесь null → честная ошибка `ProductError("db_unavailable")`; что с ней делать (отказать в
 * handshake, ответить 503, дать провайдеру повторить вебхук) — решает вызывающий, а не «тихий ноль».
 *
 * Здесь же — коэрсии типов драйверов: BIGINT/NUMERIC/sum() приходят числом (PGlite) или строкой (node-pg),
 * TIMESTAMPTZ — Date. Продуктовый код внутри считает в мс эпохи и целых микро-долларах/копейках.
 */
import type { QueryResultRow } from "pg";
import { query } from "../db/pool.js";
import { toDate } from "./rows.js";

export type ProductErrorCode =
  | "db_unavailable"
  | "invalid_input"
  | "plan_not_found"
  | "provider_none"
  | "provider_error"
  | "invoice_not_found"
  | "renew_failed"
  | "subscription_failed";

export class ProductError extends Error {
  constructor(
    readonly code: ProductErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProductError";
  }
}

/** Запрос, который ОБЯЗАН выполниться: null пула → ProductError("db_unavailable"). */
export async function q<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<R[]> {
  const res = await query<R>(text, params);
  if (res === null) {
    throw new ProductError("db_unavailable", "БД недоступна или запрос отвергнут (см. лог db) — продуктовая операция не выполнена");
  }
  return res.rows;
}

/** Первая строка результата, который ОБЯЗАН её вернуть (INSERT/UPDATE … RETURNING): пусто → честная ошибка. */
export function one<R>(rows: R[], what: string): R {
  const r = rows[0];
  if (r === undefined) throw new ProductError("db_unavailable", `${what}: запрос не вернул строку`);
  return r;
}

/** Число из значения драйвера (number | string | bigint); мусор → 0. */
export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Целое (микро-доллары, копейки, счётчики). */
export function int(v: unknown): number {
  return Math.trunc(num(v));
}

/** TIMESTAMPTZ → мс эпохи; null/мусор → null. */
export function ms(v: unknown): number | null {
  const d = toDate(v);
  return d ? d.getTime() : null;
}

/** мс эпохи → ISO для параметра TIMESTAMPTZ. */
export function iso(t: number): string {
  return new Date(t).toISOString();
}

/** JSONB-массив строк: драйвер отдаёт объект, сырые пути — строку; иное → []. */
export function jsonStrings(v: unknown): string[] {
  const parsed = typeof v === "string" ? safeJson(v) : v;
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
}

/** JSONB-объект; иное → {}. */
export function jsonObject(v: unknown): Record<string, unknown> {
  const parsed = typeof v === "string" ? safeJson(v) : v;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export const DAY_MS = 86_400_000;

/** Целое неотрицательное (валидация входа): NaN/дробь/отрицательное → ProductError("invalid_input"). */
export function requireNonNegativeInt(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ProductError("invalid_input", `поле ${field} должно быть целым неотрицательным числом, получено ${String(value)}`, { field });
  }
  return n;
}

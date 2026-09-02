/**
 * Планы продукта (таблица `plans`, миграция 0102): подписки (kind='subscription') и пакеты кредитов
 * (kind='pack'). Модель — ГИБРИД (docs/PRODUCT_FRAMEWORK_PLAN §4.4): подписка за софт (byo — свой ключ)
 * или с квотой мозга проекта (basic/pro), плюс предоплаченные пакеты, которые не сгорают.
 *
 * Единицы: цена — минимальные единицы валюты (копейки), квота/кредиты — МИКРО-доллары (integer).
 * Маппинг строки БД ↔ типа живёт ТОЛЬКО здесь: другие модули работают с `Plan`, не со строками.
 * Сиды планов ставит миграция; `upsertPlan` — административная правка (цифры — решение владельца).
 */
import { ProductError, int, jsonObject, jsonStrings, num, one, q, requireNonNegativeInt } from "./db.js";

export type PlanKind = "subscription" | "pack";
export type PlanPeriod = "month" | "once";

export interface Plan {
  id: string;
  name: string;
  kind: PlanKind;
  priceMinor: number;
  currency: string;
  period: PlanPeriod;
  llmQuotaMicro: number;
  packCreditsMicro: number;
  overageAllowed: boolean;
  overageMaxMicro: number;
  /** [] = любая модель каталога (см. QuotaResolver: [] → null). */
  modelsAllowed: string[];
  byoKey: boolean;
  trialDays: number;
  features: Record<string, unknown>;
  active: boolean;
  sortOrder: number;
}

const COLS =
  "id, name, kind, price_minor, currency, period, llm_quota_micro, pack_credits_micro, overage_allowed, " +
  "overage_max_micro, models_allowed, byo_key, trial_days, features, active, sort_order";

type Row = Record<string, unknown>;

function rowToPlan(r: Row): Plan {
  return {
    id: String(r.id),
    name: String(r.name),
    kind: r.kind === "pack" ? "pack" : "subscription",
    priceMinor: int(r.price_minor),
    currency: String(r.currency ?? "RUB"),
    period: r.period === "once" ? "once" : "month",
    llmQuotaMicro: int(r.llm_quota_micro),
    packCreditsMicro: int(r.pack_credits_micro),
    overageAllowed: r.overage_allowed === true,
    overageMaxMicro: int(r.overage_max_micro),
    modelsAllowed: jsonStrings(r.models_allowed),
    byoKey: r.byo_key === true,
    trialDays: int(r.trial_days),
    features: jsonObject(r.features),
    active: r.active !== false,
    sortOrder: num(r.sort_order),
  };
}

export async function listPlans(opts: { activeOnly?: boolean } = {}): Promise<Plan[]> {
  const where = opts.activeOnly ? "where active = true" : "";
  const rows = await q<Row>(`select ${COLS} from plans ${where} order by sort_order, id`);
  return rows.map(rowToPlan);
}

export async function getPlan(id: string): Promise<Plan | null> {
  const rows = await q<Row>(`select ${COLS} from plans where id = $1`, [id]);
  return rows[0] ? rowToPlan(rows[0]) : null;
}

/** Административная правка/создание плана. Валидация — до записи: кривой план не должен попасть в БД. */
export async function upsertPlan(plan: Plan): Promise<Plan> {
  const id = (plan.id ?? "").trim();
  if (!/^[a-z0-9_-]{1,64}$/i.test(id)) throw new ProductError("invalid_input", `id плана «${plan.id}» — только [a-z0-9_-], до 64 символов`);
  if (!plan.name?.trim()) throw new ProductError("invalid_input", "у плана должно быть имя");
  if (plan.kind !== "subscription" && plan.kind !== "pack") throw new ProductError("invalid_input", `kind плана: subscription | pack, получено ${String(plan.kind)}`);
  if (plan.period !== "month" && plan.period !== "once") throw new ProductError("invalid_input", `period плана: month | once, получено ${String(plan.period)}`);
  const priceMinor = requireNonNegativeInt(plan.priceMinor, "priceMinor");
  const llmQuotaMicro = requireNonNegativeInt(plan.llmQuotaMicro, "llmQuotaMicro");
  const packCreditsMicro = requireNonNegativeInt(plan.packCreditsMicro, "packCreditsMicro");
  const overageMaxMicro = requireNonNegativeInt(plan.overageMaxMicro, "overageMaxMicro");
  const trialDays = requireNonNegativeInt(plan.trialDays, "trialDays");
  if (!Array.isArray(plan.modelsAllowed) || plan.modelsAllowed.some((m) => typeof m !== "string")) {
    throw new ProductError("invalid_input", "modelsAllowed — массив id моделей");
  }
  const rows = await q<Row>(
    `insert into plans (${COLS})
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (id) do update set
       name = excluded.name, kind = excluded.kind, price_minor = excluded.price_minor, currency = excluded.currency,
       period = excluded.period, llm_quota_micro = excluded.llm_quota_micro, pack_credits_micro = excluded.pack_credits_micro,
       overage_allowed = excluded.overage_allowed, overage_max_micro = excluded.overage_max_micro,
       models_allowed = excluded.models_allowed, byo_key = excluded.byo_key, trial_days = excluded.trial_days,
       features = excluded.features, active = excluded.active, sort_order = excluded.sort_order
     returning ${COLS}`,
    [
      id, plan.name.trim(), plan.kind, priceMinor, (plan.currency || "RUB").toUpperCase(), plan.period,
      llmQuotaMicro, packCreditsMicro, plan.overageAllowed === true, overageMaxMicro,
      JSON.stringify(plan.modelsAllowed), plan.byoKey === true, trialDays,
      JSON.stringify(plan.features ?? {}), plan.active !== false, Number.isFinite(plan.sortOrder) ? plan.sortOrder : 100,
    ],
  );
  return rowToPlan(one(rows, "plans upsert"));
}

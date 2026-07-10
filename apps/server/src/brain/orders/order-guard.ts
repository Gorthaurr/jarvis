/**
 * Гарды заказа (§14, §0 принцип 5).
 *
 *  - spend cap: одиночный заказ не выше потолка → иначе блок;
 *  - allowlist заведений: вне списка → обязательное подтверждение;
 *  - порог тихого заказа: до порога из обычных мест — молча, иначе confirm (§14);
 *  - КРАСНАЯ ЛИНИЯ (§0): агент НИКОГДА не вводит/не хранит/не редактирует карточные
 *    данные. assertNoCardData — защитный инвариант: заказ не должен НЕСТИ карточные поля.
 *
 * Чистые функции — тестируются без сети/браузера.
 */

export interface OrderItem {
  name: string;
  qty?: number;
  price?: number;
}

export interface OrderRequest {
  userId: string;
  vendor: string;
  items: OrderItem[];
  total: number;
}

export interface OrderPolicy {
  /** Потолок одного заказа (жёсткий блок выше). */
  spendCap: number;
  /** До порога из обычных мест — без подтверждения; выше — confirm (§14). */
  silentThreshold: number;
  /** Allowlist заведений (обычные места). */
  allowedVendors: string[];
}

export const DEFAULT_ORDER_POLICY: OrderPolicy = {
  spendCap: 5000,
  silentThreshold: 1500,
  allowedVendors: [],
};

export type OrderGuardStatus = "silent" | "needs_confirm" | "blocked_cap";

export interface OrderGuardDecision {
  status: OrderGuardStatus;
  reason: string;
}

/** Ошибка нарушения красной линии карты (§0 принцип 5). */
export class CardDataError extends Error {
  constructor(detail: string) {
    super(`красная линия карты (§0): обнаружены платёжные данные — ${detail}`);
    this.name = "CardDataError";
  }
}

const CARD_KEY_RE = /\b(card(_?number)?|pan|cvv|cvc|cvc2|expiry|exp_month|exp_year)\b/i;
// Изолированный 13-19-значный токен (границы — не-цифры): после нормализации
// разделителей это и есть кандидат в номер карты. (?<!\d)/(?!\d) точнее \b на стыке цифр.
const CARD_NUMBER_RE = /(?<!\d)\d{13,19}(?!\d)/g;
// Разделители номера карты — ЛЮБОЙ не-алфанум (пробел/дефис/точка/слэш/запятая/NBSP/скобки…).
// Прежний узкий класс пропускал карту через запятую («4111,1111,1111,1111») — fail-open §0.
// Расширять безопасно: ложные срабатывания отсекает Luhn-чек ниже, а не сам факт 13–19 цифр.
const CARD_SEP_RE = /[^0-9A-Za-z]/g;

/**
 * Luhn-чек (контрольная сумма банковской карты). Нужен, чтобы не путать карту с
 * EAN-13 штрихкодом, длинным артикулом, телефоном или total в копейках — иначе
 * любой 13–19-значный номер ложно рубит весь заказ (отказ в обслуживании).
 */
export function passesLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Инвариант §0: заказ НЕ должен содержать карточных/платёжных данных ни в ключах,
 * ни в значениях. Бросает CardDataError при обнаружении.
 */
export function assertNoCardData(obj: unknown): void {
  const scan = (value: unknown, keyPath: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      const compact = value.replace(CARD_SEP_RE, "");
      // Карта = изолированные 13–19 цифр, ПРОШЕДШИЕ Luhn. Без Luhn штрихкоды/ID/телефоны
      // ложно считались бы картой и блокировали заказ (§0 важна, но не ценой ложных отказов).
      for (const m of compact.matchAll(CARD_NUMBER_RE)) {
        if (passesLuhn(m[0])) {
          throw new CardDataError(`значение похоже на номер карты (${keyPath})`);
        }
      }
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (CARD_KEY_RE.test(k)) throw new CardDataError(`ключ "${k}"`);
        scan(v, keyPath ? `${keyPath}.${k}` : k);
      }
    }
  };
  scan(obj, "");
}

/** Решение по заказу (§14). spend cap — жёсткий; allowlist/порог → confirm. */
export function checkOrder(req: OrderRequest, policy: OrderPolicy): OrderGuardDecision {
  if (req.total > policy.spendCap) {
    return { status: "blocked_cap", reason: `сумма ${req.total} выше потолка ${policy.spendCap}` };
  }
  const usual = policy.allowedVendors.map((v) => v.toLowerCase()).includes(req.vendor.toLowerCase());
  if (!usual) {
    return { status: "needs_confirm", reason: "заведение не в списке обычных" };
  }
  if (req.total > policy.silentThreshold) {
    return { status: "needs_confirm", reason: `сумма ${req.total} выше порога тихого заказа ${policy.silentThreshold}` };
  }
  return { status: "silent", reason: "обычное место и сумма в пороге" };
}

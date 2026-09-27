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
import { cardNumberIn, passesLuhn } from "@jarvis/shared";

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
// W2 (пакет 0): Луна и нормализация разделителей — в @jarvis/shared/credential-risk (одна эвристика с гардом ввода
// и клиентским рубежом §0). Реэкспорт passesLuhn — для прежних потребителей.
export { passesLuhn };

/**
 * Инвариант §0: заказ НЕ должен содержать карточных/платёжных данных ни в ключах,
 * ни в значениях. Бросает CardDataError при обнаружении.
 */
export function assertNoCardData(obj: unknown): void {
  const scan = (value: unknown, keyPath: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      // Карта = изолированные 13–19 цифр (любые разделители), ПРОШЕДШИЕ Luhn: без Luhn штрихкоды/ID/телефоны
      // ложно считались бы картой и блокировали заказ (§0 важна, но не ценой ложных отказов).
      if (cardNumberIn(value)) throw new CardDataError(`значение похоже на номер карты (${keyPath})`);
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
  // Аудит ядра [7]: жёсткий кап FAIL-CLOSED на нечисловой/отрицательной сумме. `NaN > spendCap` === false
  // → нераспознанная сумма («12,500»/«12 500» → Number → NaN) проходила потолок мимо (§0/§14 fail-open).
  // Не можем оценить сумму → трактуем как превышение капа (блок), а не как «ок».
  if (!Number.isFinite(req.total) || req.total < 0) {
    return { status: "blocked_cap", reason: `сумма не распознана (${req.total}) — заказ заблокирован для безопасности` };
  }
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

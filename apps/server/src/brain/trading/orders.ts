/**
 * Модель ордеров и позиций (§трейдинг, слой 2: ИСПОЛНЕНИЕ).
 *
 * Только типы и чистые предикаты (без сети/состояния) — общий контракт для риск-движка, брокеров
 * (бумажный/живой) и исполнителя. Деньги двигает БРОКЕР; здесь — лишь форма заявки и результата.
 */
import type { Market } from "./market.js";

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";

/** Заявка на сделку (что купить/продать и сколько). */
export interface OrderRequest {
  symbol: string;
  market: Market;
  side: Side;
  /** Количество (лоты/контракты/единицы крипты). > 0. */
  qty: number;
  type: OrderType;
  /** Цена для limit-заявки (для market игнорируется). */
  limitPrice?: number;
}

/** Открытая позиция по инструменту. qty>0 long, qty<0 short. */
export interface Position {
  symbol: string;
  market: Market;
  qty: number;
  /** Средняя цена входа. */
  avgPrice: number;
}

/** Итог исполнения заявки (брокер НИКОГДА не врёт об исполнении — §честность). */
export interface OrderResult {
  ok: boolean;
  orderId?: string;
  /** Исполненное количество (0 при отказе). */
  filledQty: number;
  /** Средняя цена исполнения. */
  avgPrice?: number;
  status: "filled" | "rejected" | "pending";
  /** Причина отказа/частичного (для честного отчёта). */
  reason?: string;
}

/** Нотиональная стоимость заявки (|qty|·цена) — основа риск-лимитов. */
export function notional(qty: number, price: number): number {
  return Math.abs(qty) * price;
}

/**
 * Применить исполнение к позиции (чистая функция): усреднение при наращивании, частичное/полное
 * закрытие при противоположной стороне, переворот через ноль. Возвращает новую позицию (qty 0 → закрыта)
 * и реализованный PnL по закрытой части (для дневного стоп-лосса).
 */
export function applyFill(
  pos: Position | undefined,
  symbol: string,
  market: Market,
  side: Side,
  qty: number,
  price: number,
): { position: Position; realizedPnl: number } {
  const signed = side === "buy" ? qty : -qty;
  const prevQty = pos?.qty ?? 0;
  const prevAvg = pos?.avgPrice ?? 0;
  let realizedPnl = 0;
  let newQty = prevQty + signed;
  let newAvg = prevAvg;

  if (prevQty === 0 || Math.sign(prevQty) === Math.sign(signed)) {
    // открытие/наращивание в ту же сторону → усредняем цену входа
    newAvg = (Math.abs(prevQty) * prevAvg + Math.abs(signed) * price) / (Math.abs(prevQty) + Math.abs(signed));
  } else {
    // противоположная сторона → закрываем (полностью/частично), считаем PnL по закрытой части
    const closedQty = Math.min(Math.abs(signed), Math.abs(prevQty));
    realizedPnl = closedQty * (price - prevAvg) * (prevQty > 0 ? 1 : -1);
    if (Math.abs(signed) > Math.abs(prevQty)) newAvg = price; // переворот: остаток открыт по новой цене
    else if (newQty === 0) newAvg = 0; // закрыто в ноль
  }
  return { position: { symbol, market, qty: newQty, avgPrice: newQty === 0 ? 0 : newAvg }, realizedPnl };
}

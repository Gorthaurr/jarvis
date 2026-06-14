/**
 * Оркестрация заказа еды (§14, UC-5).
 *
 * Поток: красная линия карты (§0) → гарды (spend cap / allowlist / порог) → confirm
 * выше порога → идемпотентность (retry не оформит дубль) → размещение (browser-автоматизация
 * на клиенте). Карта уже привязана у вендора; чекаут с 3DS/SCA подтверждает пользователь —
 * агент карточные данные НЕ вводит (§0).
 *
 * Чистая оркестрация с инъекцией зависимостей — тестируется без сети/браузера.
 */
import {
  type OrderPolicy,
  type OrderRequest,
  assertNoCardData,
  checkOrder,
} from "./order-guard.js";

export interface OrderDeps {
  requestConfirm: (summary: string) => Promise<{ approved: boolean }>;
  isAlreadyPlaced: (key: string) => boolean;
  markPlaced: (key: string) => void;
  /** Размещение заказа клиентской browser-автоматизацией (§6). */
  place: (req: OrderRequest) => Promise<{ ok: boolean; error?: string; orderId?: string }>;
}

export type OrderStatus = "placed" | "blocked" | "denied" | "duplicate" | "error";

export interface OrderResult {
  status: OrderStatus;
  reason?: string;
  orderId?: string;
  key?: string;
}

function orderKey(req: OrderRequest): string {
  const items = req.items.map((i) => `${i.name}x${i.qty ?? 1}`).sort().join(",");
  let h = 5381;
  const s = `${req.userId}|${req.vendor}|${items}|${req.total}`;
  for (let i = 0; i < s.length; i += 1) h = (h * 33) ^ s.charCodeAt(i);
  return `${req.vendor}:${(h >>> 0).toString(36)}`;
}

export async function placeOrder(
  req: OrderRequest,
  policy: OrderPolicy,
  deps: OrderDeps,
): Promise<OrderResult> {
  // 0) Красная линия (§0): заказ не должен нести карточные данные. Бросает CardDataError.
  assertNoCardData(req);

  // 1) Гарды (§14): spend cap (жёстко) / allowlist / порог.
  const decision = checkOrder(req, policy);
  if (decision.status === "blocked_cap") {
    return { status: "blocked", reason: decision.reason };
  }
  if (decision.status === "needs_confirm") {
    const summary = `Заказ в «${req.vendor}» на ${req.total}: ${req.items.map((i) => i.name).join(", ")}. Оформляю?`;
    const res = await deps.requestConfirm(summary);
    if (!res.approved) return { status: "denied", reason: "пользователь отклонил" };
  }

  // 2) Идемпотентность (§14): дубль при retry не оформляется.
  const key = orderKey(req);
  if (deps.isAlreadyPlaced(key)) return { status: "duplicate", reason: "уже оформлено (idempotency)", key };

  // 3) Размещение (browser-автоматизация на клиенте; карту агент не вводит, §0).
  const placed = await deps.place(req);
  if (!placed.ok) return { status: "error", reason: placed.error ?? "ошибка оформления", key };

  deps.markPlaced(key);
  return { status: "placed", orderId: placed.orderId, key };
}

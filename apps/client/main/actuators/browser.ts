/**
 * Актуатор драйва браузера через Chrome DevTools Protocol (§6).
 *
 * browser.open/act/read работают через выделенный Chrome-инстанс по CDP (browser-cdp.ts).
 * Интенты (play/next/scroll/click/type/back/...) и текст резолвятся в DOM-элементы по
 * видимому тексту/aria, а НЕ в хрупкие пиксели. За BrowserController позже встанет
 * hak-browser (anti-detect, профиль пользователя) — вызовы не изменятся.
 */
import { createLogger } from "@jarvis/shared";
import { type PageContent, browserController } from "./browser-cdp.js";

const log = createLogger("actuator:browser");

export type { PageContent };

/** Открыть URL в управляемом браузере (CDP). */
export async function open(url: string): Promise<void> {
  await browserController().open(url);
}

/** Выполнить интент в браузере (CDP): play/pause/next/prev/scroll/click/type/back/forward. */
export async function act(intent: string, params?: Record<string, unknown>): Promise<void> {
  log.debug("browser.act", { intent });
  await browserController().act(intent, params);
}

/** Извлечь читаемый контент страницы (возвращается в ActionResult.data). */
export async function read(selectorIntent: string): Promise<PageContent> {
  log.debug("browser.read", { selectorIntent });
  return browserController().read(selectorIntent);
}

/**
 * Оформить заказ через browser-автоматизацию (§14, UC-5). Серверные гарды
 * (spend cap/allowlist/confirm/idempotency) уже пройдены. Карта привязана у вендора;
 * чекаут с 3DS/SCA подтверждает САМ пользователь — агент карточные данные НЕ вводит (§0).
 *
 * // TODO(M7): реальный CDP-драйв hak-браузера: открыть вендора → собрать корзину по
 *   ролям/тексту → дойти до чекаута и ОСТАНОВИТЬСЯ перед вводом платёжных данных.
 */
export async function placeOrder(order: { vendor: string; items: unknown[]; total: number }): Promise<{ orderId: string }> {
  // Защита в глубину (§0): на клиенте заказ тоже не должен нести карточные данные.
  const blob = JSON.stringify(order);
  if (/\b\d{13,19}\b/.test(blob.replace(/[\s-]/g, "")) || /\b(cvv|cvc|pan|card_?number)\b/i.test(blob)) {
    throw new Error("красная линия карты (§0): заказ содержит платёжные данные — отказ");
  }
  log.warn(`order.place в «${order.vendor}» на ${order.total} — browser-автоматизация stub (M7)`);
  // TODO(M7): реальная сборка корзины и доведение до чекаута без ввода карты.
  return { orderId: `stub-order-${order.vendor}` };
}

/**
 * Актуатор драйва hak-браузера через puppeteer-core (§6).
 *
 * browser.act/browser.read работают с уже запущенным «honest» браузером (реальный профиль
 * пользователя, не headless), подключаясь по CDP. Интенты (play/next/scroll/pause) и
 * selectorIntent резолвятся в a11y-роли/тексты, а НЕ в хрупкие CSS-селекторы (§6).
 *
 * browser.open реализован НЕ здесь, а в actuators/apps.ts (launchApp с URL/браузером) —
 * это просто запуск процесса; для M0 этого достаточно.
 *
 * // TODO(M3): подключить puppeteer-core по CDP к hak-браузеру, реализовать act()/read().
 */
import { createLogger } from "@jarvis/shared";
import { NotImplementedError } from "./input.js";

const log = createLogger("actuator:browser");

export type BrowserIntent = "play" | "next" | "scroll" | "pause";

/** Выполнить интент в браузере (hak-browser). */
export async function act(
  _intent: BrowserIntent,
  _params?: Record<string, unknown>,
): Promise<void> {
  log.warn("browser.act — puppeteer-core драйв не реализован (M3)");
  throw new NotImplementedError("browser.act");
}

/** Извлечь контент по интенту селектора (возвращается в ActionResult.data). */
export async function read(_selectorIntent: string): Promise<unknown> {
  log.warn("browser.read — puppeteer-core драйв не реализован (M3)");
  throw new NotImplementedError("browser.read");
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

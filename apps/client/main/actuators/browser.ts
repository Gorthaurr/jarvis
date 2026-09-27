/**
 * Актуатор драйва браузера через Chrome DevTools Protocol (§6).
 *
 * browser.open работает через выделенный Chrome-инстанс по CDP (browser-cdp.ts). Руки во вкладках владельца
 * (клик/ввод/чтение) — расширение (W1); клиентские browser.act/browser.read по CDP удалены (B-12: мертвы на
 * Chrome 136+, клик подстрокой мимо §14). За BrowserController позже встанет hak-browser — вызовы не изменятся.
 */
import { createLogger } from "@jarvis/shared";
import { browserController } from "./browser-cdp.js";

const log = createLogger("actuator:browser");

/** Открыть URL в управляемом браузере (CDP). */
export async function open(url: string): Promise<void> {
  await browserController().open(url);
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
  // ЧЕСТНОСТЬ (§): НЕ возвращаем фейковый успех. order.place вне набора модели (EXCLUDED_TOOLS);
  // пока реальной сборки корзины/чекаута нет — честный провал, а не ложный orderId. TODO(M7): реализовать.
  log.warn(`order.place в «${order.vendor}» на ${order.total} — не реализовано (M7)`);
  throw new Error("order.place не реализован (M7): реальная сборка корзины/чекаут ещё не сделаны");
}

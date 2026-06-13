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

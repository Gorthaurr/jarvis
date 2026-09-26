/**
 * Печать текста посимвольно с человеческим джиттером в сайдкаре (§3 принцип 3).
 *
 * W2 (пакет 0): перенос `typeText` из input.ts без изменения поведения (там — реэкспорт). Владелец — П1 (G-15):
 * preflight ВСЕГО текста (secret и commit) до первого куска; куски по `\n`/`\t` через pressKey("Enter"/"Tab"); после
 * Tab следующий кусок судится заново (в фокусе кнопка → отказ); одно «да» на key:enter — одна отправка.
 */
import { createLogger } from "@jarvis/shared";
import { assertNoDrawingOverlay, assertNoOverlayDuring } from "../selection/overlay-error.js";
import { injectRpc } from "./inject.js";
import { noteJarvisInput } from "./input-mark.js";
import { ensureSidecar } from "./sidecar-ready.js";

const log = createLogger("actuator:input");

export async function typeText(text: string): Promise<void> {
  assertNoDrawingOverlay();
  noteJarvisInput();
  ensureSidecar();
  log.debug("input.type", { len: text.length });
  // Таймаут по длине: посимвольный ввод с джиттером — десятки секунд на абзац. Дефолтные 5с
  // рвали длинный текст на полуслове (RPC reject), а сайдкар продолжал печатать → рассинхрон.
  const timeoutMs = Math.min(180_000, 5_000 + text.length * 120);
  const t0 = Date.now();
  await injectRpc("type", { text }, timeoutMs);
  // Контроль-6 (C5R-2): печать идёт секунды — вуаль, открывшаяся ПОСРЕДИ, забирает остаток нажатий в окно
  // рисования, а сайдкар отвечает ok. Честно: ушло, исход не подтверждён (не «выполнено» и не «не выполнено»).
  assertNoOverlayDuring(t0, "Печать текста");
}

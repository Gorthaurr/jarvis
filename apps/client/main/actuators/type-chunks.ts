/**
 * Печать текста посимвольно с человеческим джиттером в сайдкаре (§3 принцип 3). W2 П1 (G-15):
 *  - ВЕСЬ текст сперва проходит предпроверку рубежа (§0 секрет, §14 переводы строк) — ДО первого куска: «привет\n» в
 *    Telegram без гранта = ноль напечатанного, а не «привет» в поле и отказ на Enter;
 *  - куски по `\n`/`\t`, между ними — pressKey("Enter"/"Tab") через рубеж: одно «да» на `key:enter` — одна отправка,
 *    кратность гранта = число переводов строки (C# `\n` → VK_RETURN — §6 плана, TS режет сам);
 *  - после Tab фокус мог встать на кнопку, а пробел в ней = нажатие: следующий кусок судится заново как Space в фокус;
 *  - отказ ПОСЛЕ ушедшего куска — «часть ушла» (injected): исход неизвестен, повторять вслепую нельзя.
 */
import { createLogger } from "@jarvis/shared";
import { DrawingOverlayError, assertNoDrawingOverlay, assertNoOverlayDuring } from "../selection/overlay-error.js";
import { ActionError, actionErrorOf } from "./action-error.js";
import { injectRpc } from "./inject.js";
import { preflightKeys, preflightText } from "./injection-guard.js";
import { pressKey } from "./input.js";
import { noteJarvisInput } from "./input-mark.js";
import { ensureSidecar } from "./sidecar-ready.js";

const log = createLogger("actuator:input");

type Part = { text: string } | { key: "Enter" | "Tab" };

/** Разрезать текст: переводы строки (`\r\n`, `\r`, `\n`) → Enter, `\t` → Tab, между ними — куски печати. */
export function splitTyping(text: string): Part[] {
  const out: Part[] = [];
  for (const piece of text.split(/(\r\n|\r|\n|\t)/u)) {
    if (!piece) continue;
    out.push(piece === "\t" ? { key: "Tab" } : /^[\r\n]+$/u.test(piece) ? { key: "Enter" } : { text: piece });
  }
  return out;
}

async function typeChunk(text: string): Promise<void> {
  // Таймаут по длине: посимвольный ввод с джиттером — десятки секунд на абзац. Дефолтные 5с
  // рвали длинный текст на полуслове (RPC reject), а сайдкар продолжал печатать → рассинхрон.
  const timeoutMs = Math.min(180_000, 5_000 + text.length * 120);
  const t0 = Date.now();
  await injectRpc("type", { text }, timeoutMs);
  // Контроль-6 (C5R-2): вуаль, открывшаяся ПОСРЕДИ печати, забирает остаток нажатий — ушло, исход не подтверждён.
  assertNoOverlayDuring(t0, "Печать текста");
}

/** Часть текста уже ушла: отказ/сбой дальше — «исход неизвестен», не «не напечатано». */
function partial(e: unknown): unknown {
  const msg = `${e instanceof Error ? e.message : String(e)} — часть текста УЖЕ напечатана, исход неизвестен, не повторяй вслепую`;
  if (e instanceof DrawingOverlayError) return new DrawingOverlayError(msg, true);
  const ae = actionErrorOf(e);
  return new ActionError(msg, { code: ae?.code ?? "runtime", ...(ae?.data !== undefined ? { data: ae.data } : {}), injected: true });
}

export async function typeText(text: string): Promise<void> {
  assertNoDrawingOverlay();
  noteJarvisInput();
  ensureSidecar();
  log.debug("input.type", { len: text.length });
  const parts = splitTyping(text);
  // Один кусок без Enter/Tab судится своей же инжекцией целиком — отдельная предпроверка ничего не добавит.
  if (parts.length > 1 || !parts.every((p) => "text" in p)) await preflightText(text);
  let sent = false;
  let afterTab = false;
  for (const part of parts) {
    try {
      if ("key" in part) {
        await pressKey(part.key);
        afterTab = part.key === "Tab";
      } else {
        if (afterTab) await preflightKeys(["Space"]); // после Tab в фокусе может быть кнопка: пробел = нажатие
        await typeChunk(part.text);
        afterTab = false;
      }
      sent = true;
    } catch (e) {
      throw sent ? partial(e) : e;
    }
  }
}

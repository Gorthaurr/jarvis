/**
 * W1: ЧЕСТНЫЙ исход провала browser_act / browser_batch (закон 1) — отдельно от хендлера (browser.ts и так велик).
 *
 * - Таймаут/разрыв связи ПОСЛЕ отправки меняющего интента (B-4) — «не знаю, сработало ли — сверь», `uncertain`, и
 *   БЕЗ открытия координатного хатча: раньше это был «Не вышло» + markBrowserActMiss → модель жала повторно или
 *   кликала по координатам — двойная отправка формы.
 * - Страница отказалась печатать в секретное поле (`secret_field`, §0) — «вводит владелец», тоже без хатча:
 *   иначе следующим шагом был бы клик по полю пароля и input_type.
 * - Закрытая вкладка (`tab_closed`) и несколько подходящих элементов (`ambiguous`) — элемента «нет» не значит, хатч
 *   к координатам не открываем.
 * - Текст ошибки расширения несёт текст СТРАНИЦЫ (подписи, варианты <option>, B-10) — только в <untrusted_content>;
 *   наша подсказка лестницы — снаружи.
 */
import type { ToolResult } from "../dispatch.js";
import { err, wrapUntrusted } from "../dispatch-util.js";
import { CREDENTIAL_REFUSAL } from "../credential-guard.js";
import { errText, isExtNoReply, pageErrorCode } from "../ext-errors.js";
import { intentMayMutate } from "../browser-params.js";

/** Кап текста ошибки со страницы (варианты select бывают сотнями). */
const PAGE_ERROR_CAP = 1_500;

/** Текст ошибки расширения — внутрь untrusted (скобки, чтобы не порвать делимитер, режем). */
export function pageErrorBlock(source: string, msg: string): string {
  const clean = msg.replace(/[<>]/gu, " ");
  return wrapUntrusted(source, clean.length > PAGE_ERROR_CAP ? `${clean.slice(0, PAGE_ERROR_CAP)} …(обрезано)` : clean);
}

/** «Исход неизвестен» — err (не успех), но с меткой uncertain: журнал и петля не зовут его «не сделано». */
export function unknownOutcome(text: string): ToolResult {
  const out = err(text);
  out.uncertain = true;
  return out;
}

/** Страница отказала в поле пароля/кода (§0) — одна формулировка на browser_act и шаг берста. */
export function secretFieldRefusal(what: string): ToolResult {
  return err(`${what}: это поле пароля/кода — страница пометила его секретным. ${CREDENTIAL_REFUSAL}. Попроси владельца ввести руками и продолжай ПОСЛЕ этого.`);
}

/**
 * Провал, который НЕ является «элемента нет в DOM» (транспорт, §0, закрытая вкладка, неоднозначность) → готовый
 * ToolResult; иначе null (вызывающий идёт по лестнице inspect → canvas-хатч). `what` — «browser_act «click»».
 */
export function nonDomFailure(what: string, intent: string, e: unknown): ToolResult | null {
  const msg = errText(e);
  if (isExtNoReply(e)) {
    if (!intentMayMutate(intent)) return err(`${what}: расширение не ответило (${msg}) — действие не подтверждено; можно повторить.`);
    return unknownOutcome(
      `${what}: расширение не ответило (${msg}). НЕ ЗНАЮ, сработало ли — действие могло уйти. НЕ повторяй вслепую ` +
        `(второй клик/Enter = дубль) и не кликай по координатам: сверь browser_inspect / browser_read, потом решай.`,
    );
  }
  switch (pageErrorCode(e)) {
    case "secret_field":
      return secretFieldRefusal(what);
    case "tab_closed":
      return err(`${what}: этой вкладки больше нет (закрыта). В другую вкладку НЕ бил. Возьми актуальный tabId из browser_tabs или открой страницу заново (browser_open).`);
    case "ambiguous":
      return err(`${what}: под описание подходят несколько элементов — ничего не нажимал. Возьми точный ref из browser_inspect{query} и повтори.\n${pageErrorBlock("browser-act-error", msg)}`);
    default:
      return null;
  }
}

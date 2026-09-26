/**
 * W1: ЧЕСТНЫЙ исход провала browser_act / browser_batch (закон 1) — отдельно от хендлера (browser.ts и так велик).
 *
 * - Таймаут/разрыв связи ПОСЛЕ отправки меняющего интента (B-4) — «не знаю, сработало ли — сверь», `uncertain`, и
 *   БЕЗ открытия координатного хатча: раньше это был «Не вышло» + markBrowserActMiss → модель жала повторно или
 *   кликала по координатам — двойная отправка формы.
 * - Страница отказалась печатать в секретное поле (`secret_field`, §0) — «вводит владелец», тоже без хатча:
 *   иначе следующим шагом был бы клик по полю пароля и input_type.
 * - Фрейм перезагрузился во время действия (`frame_gone`) — тоже «исход неизвестен» (W1-5); `no_effect` — элемент есть.
 * - Закрытая вкладка (`tab_closed`/`tab_gone`) и несколько подходящих элементов (`ambiguous`) — элемента «нет» не значит, хатч
 *   к координатам не открываем.
 * - Текст ошибки расширения несёт текст СТРАНИЦЫ (подписи, варианты <option>, B-10) — только в <untrusted_content>;
 *   наша подсказка лестницы — снаружи.
 */
import type { ToolResult } from "../dispatch.js";
import { err, wrapUntrusted } from "../dispatch-util.js";
import { CREDENTIAL_REFUSAL } from "../credential-guard.js";
import { errText, isExtNoReply, pageErrorCode } from "../ext-errors.js";
import { intentMayMutate } from "../browser-params.js";

/** Хвост «исход неизвестен» — одна формулировка на таймаут, frame_gone и uncertain берста. */
const UNKNOWN_TAIL = "НЕ ЗНАЮ, сработало ли — действие могло уйти. НЕ повторяй вслепую (второй клик/Enter = дубль) и не кликай по координатам: сверь browser_inspect / browser_read, потом решай.";

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
    return unknownOutcome(`${what}: расширение не ответило (${msg}). ${UNKNOWN_TAIL}`);
  }
  const code = pageErrorCode(e);
  switch (code) {
    case "secret_field":
      return secretFieldRefusal(what);
    case "tab_closed":
    case "tab_gone":
      return err(`${what}: этой вкладки больше нет (закрыта). В другую вкладку НЕ бил. Возьми актуальный tabId из browser_tabs или открой страницу заново (browser_open).`);
    case "ambiguous":
      return err(`${what}: под описание подходят несколько элементов — ничего не нажимал. Возьми точный ref из browser_inspect{query} и повтори.\n${pageErrorBlock("browser-act-error", msg)}`);
    case "frame_gone":
      // W1-5: фрейм перезагрузился ВО ВРЕМЯ действия — оно могло уже сработать. Не «не вышло» и не координаты.
      if (!intentMayMutate(intent)) return err(`${what}: целевой фрейм перезагрузился — действие не подтверждено; сделай browser_inspect и повтори.`);
      return unknownOutcome(`${what}: целевой фрейм перезагрузился во время действия. ${UNKNOWN_TAIL}`);
    case "no_effect":
      // Элемент найден и нажат, видимого эффекта нет — элемент ЕСТЬ, координатный клик не нужен.
      return err(`${what}: элемент нажат, но видимого эффекта нет (кнопка не та или неактивна). НЕ кликай по координатам: сверь browser_inspect и выбери другой элемент.\n${pageErrorBlock("browser-act-error", msg)}`);
    default:
      return null;
  }
}

/** Берст остановился на шаге: честный текст по коду страницы; текст ошибки со страницы — в untrusted (B-10). */
export function batchStopped(r: { error?: string; code?: string } | undefined, head: string): ToolResult {
  const code = pageErrorCode(r ?? {}) ?? pageErrorCode(String(r?.error ?? ""));
  // Шаг упёрся в кнопку-коммит, которую сервер не распознал (подпись видна только странице): не жали. Подпись не
  // пересказываем (её задаёт страница, M11) — этот шаг отдельным browser_act, там будет вопрос владельцу.
  if (code === "commit_confirm") return err(`${head} — следующий шаг жмёт кнопку-коммит. Сделай его отдельным browser_act (спросит владельца).`);
  // §0: страница отказалась печатать в поле пароля/кода — дальше вводит владелец (не обходить другим шагом).
  if (code === "secret_field") return secretFieldRefusal(`${head} — следующий шаг`);
  if (code === "tab_closed" || code === "tab_gone") return err(`${head} — вкладка закрыта; в другую не бил. Возьми tabId из browser_tabs.`);
  // W1-7/EXT-6/W1-5: шаг ушёл, а страница перешла или фрейм перезагрузился — исход шага неизвестен, остаток не делали.
  if (code === "uncertain" || code === "frame_gone") return unknownOutcome(`${head}: исход последнего шага неизвестен (страница перешла/фрейм перезагрузился). ${UNKNOWN_TAIL}`);
  // Устаревший снимок и прочее → честно, без слепого повтора: пересними и продолжи.
  return err(`${head}: шаг не выполнен. Сделай browser_inspect и продолжи с актуального снимка.\n${pageErrorBlock("browser-batch-error", String(r?.error ?? "без описания"))}`);
}

/**
 * Смерть контекста страницы при chrome.scripting.executeScript (закон 1: ушло / не ушло / неизвестно). Исход решает
 * МЕСТО возникновения (адверс-ревью W1 р2, srv-regress-4):
 *  • ДО действия — инъекция во фрейм, которого уже нет («No frame with id»: функция не запускалась), или смерть на
 *    подготовительном шаге (штамп ref, `before`) → frame_missing (фрейм) / ref_stale (top): «не выполнял — пересними»;
 *  • ВО ВРЕМЯ действия во фрейме (removed/destroyed посреди исполнения) → frame_gone: исход неизвестен, мог сработать.
 * Навигация top-фрейма во время клика решается в tabAct (там сверка адреса вкладки).
 */
export function contextDied(msg) {
  return /(removed|destroyed|invalidated|closed|No frame)/i.test(String(msg || ""));
}

/** Ответ-провал {ok:false, code, error} по месту смерти контекста. frameId === undefined — top-фрейм (только `before`). */
export function contextLost(frameId, msg, before) {
  if (before || /No frame with id/i.test(String(msg || ""))) {
    return frameId !== undefined
      ? { ok: false, code: "frame_missing", error: "целевой фрейм " + frameId + " пропал ДО действия — ничего не выполнял. Сделай свежий browser_inspect и повтори по новому снимку." }
      : { ok: false, code: "ref_stale", error: "страница перезагрузилась ДО действия — ничего не выполнял. Сделай browser_inspect заново." };
  }
  // Целевой ФРЕЙМ исчез посреди действия. НЕ вкладочная навигация-успех (ревью #4) и не криптичная ошибка Chrome в
  // canvas-хатч: честное «могло сработать» + запрет слепого повтора (тот же selector сработал бы в новом фрейме дважды).
  return { ok: false, code: "frame_gone", error: "целевой фрейм " + frameId + " исчез (страница/встроенный фрейм перезагрузились — возможно, действие уже сработало). Сделай свежий browser_inspect и сверься ПРЕЖДЕ чем повторять — не кликай вслепую." };
}

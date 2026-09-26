/**
 * §14 для учебных LMS (боевой прогон 26.09, ЭИОС eos.imes.su на Moodle). Чистые ДАННЫЕ, без импортов.
 *
 * Хост у каждого вуза свой (eos.imes.su, lms.vuz.ru…) — список хостов не работает, поэтому опасное место узнаём по
 * ПУТИ страницы ядра Moodle. Необратимое там не только «Отправить»: старт попытки тратит лимит «Разрешено попыток»
 * и запускает неостановимый таймер, «Проверить» в интерактивном режиме оценивает вопрос со штрафом, в задании без
 * черновиков «Сохранить» — это и есть сдача. Короткие слова («Сохранить», «Продолжить», «Проверить») судим только
 * ЦЕЛОЙ подписью: «Продолжить текущую попытку» — обычная навигация, вопроса не стоит.
 */

const LMS_PAGES: ReadonlyArray<RegExp> = [
  /\/mod\/quiz\/(?:view|attempt|summary|startattempt|processattempt)\.php/iu,
  /\/mod\/assign\/view\.php/iu,
];

/** Страница попытки: Enter/submit формы тут = переход по страницам с сохранением ответов (обратимо). */
const ATTEMPT_PAGE = /\/mod\/quiz\/attempt\.php/iu;

// «Сохранить изменения» — кнопка формы ответа в задании (assign savechanges); без черновиков это и есть сдача (ревью 26.09).
export const LMS_COMMIT_RE =
  /(?:пройти тест|начать попытку|начать тестирование|отправить на проверку|attempt quiz|start attempt|re-?attempt quiz|submit assignment|^\s*(?:проверить|сохранить(?: изменения)?|продолжить|check|save|save changes|continue)\s*$)/iu;

/** Двухшаговая сдача теста: кнопка страницы → окно подтверждения с ТОЙ ЖЕ подписью. Одно «да» на связку. */
export const LMS_TWO_STEP_RE = /отправить вс[её] и завершить тест|submit all and finish/iu;

export function isLmsPage(url: string): boolean {
  return LMS_PAGES.some((re) => re.test(url));
}

/** Enter/submit на этой LMS-странице — коммит? На странице попытки — нет (сохранение + переход). */
export function lmsKeyCommits(url: string): boolean {
  return !ATTEMPT_PAGE.test(url);
}

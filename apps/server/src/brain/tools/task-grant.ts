/**
 * «Поручение = разрешение» для учебных систем (решение владельца 28.09: «пусть не спрашивает разрешение — войти в
 * учётку, начать тест, — если само задание это подразумевает»).
 *
 * §14 на LMS (`commit-lms.ts`) спрашивал КАЖДЫЙ «Пройти тест» / «Проверить» / «Отправить всё» — даже когда владелец
 * сам сказал «пройди все тесты». Теперь такая реплика владельца выдаёт СЕССИОННЫЙ грант на учебные страницы: пока он
 * жив, коммиты LMS-пути (старт попытки, проверка, сдача) идут без вопроса. Остальное §14 не трогаем: мессенджеры,
 * банк, оплата, удаление, отправка людям, неизвестный сайт — спрашиваем как раньше.
 *
 * Грант выдаёт ТОЛЬКО реплика владельца (`noteOwnerTurn` зовёт handleUserText); текст страницы/инструмента его не
 * ставит — prompt-инъекция со страницы разрешения не получит. Реплика без «Джарвис» (фон, ТВ) и машинный реэнтри
 * (watch-action) не выдают и не продлевают. «Стоп/хватит/отмена/не сдавай» — снимают.
 */
import { riskyHostCategory } from "./commit-gate.js";
import { isLmsPage } from "./commit-lms.js";

/** Сколько живёт грант после последней реплики владельца (скользящее окно: «иди» продлевает). */
export const EDU_GRANT_MS = 3 * 60 * 60_000;

const LETTER = "[\\p{L}\\p{N}]";
/** Корень слова с границами по буквам (JS `\b` кириллицу не знает). */
const word = (stem: string): string => `(?<!${LETTER})${stem}${LETTER}*`;

const DO = ["пройд", "прохо[дж]", "прохожд", "сда[йв]", "сдач", "сдать", "выполн", "реш[аиэ]", "решай", "делай", "сделай"].map(word).join("|");
const WORK = ["тест", "курс", "урок", "лекци", "задани", "экзамен", "контрольн", "викторин", "квиз", "зач[её]т", "модул"].map(word).join("|");
/** «пройди все мини-тесты», «тесты пройди», «в гражданском процессе пройдет все мини-курсы» (STT путает окончания). */
const EDU_TASK = new RegExp(`(?:${DO})[^.!?]{0,60}(?:${WORK})|(?:${WORK})[^.!?]{0,60}(?:${DO})`, "iu");

/** Слово целиком (без хвоста): «да» — не «данные». */
const exact = (w: string): string => `(?<!${LETTER})${w}(?!${LETTER})`;
const START = ["иди", "идём", "идем", "давай", "поехали", "погнали", "продолжай", "дальше", "делай", "сдавай", "начинай", "вперёд", "вперед", "да", "ага", "угу", "хорошо", "ок", "окей"].map(exact).join("|");
const TAIL = ["иди", "давай", "дальше", "все", "всё", "пожалуйста", "сэр"].map(exact).join("|");
/** Короткое продолжение уже данного поручения: «иди», «давай», «да», «дальше». Продлевает, но не выдаёт. */
const CONTINUE = new RegExp(`^(?:джарвис[,.!\\s]*)?(?:${START})(?:[\\s,.!]+(?:${TAIL}))*[\\s.!]*$`, "iu");

/** Владелец отзывает поручение. */
const REVOKE = new RegExp(
  `${["стоп", "хватит", "отмен", "прекрати", "остановись", "не\\s+(?:надо|нужно|сдавай|делай|трогай|начинай|проходи)"].map(word).join("|")}`,
  "iu",
);

const until = new Map<string, number>();

export interface OwnerTurn {
  /** Реплика адресована Джарвису («Джарвис…» / кнопка / окно разговора владельцу) — не фон и не машинный реэнтри. */
  addressed: boolean;
  now?: number;
}

/** Учесть реплику владельца: выдать/продлить/снять грант на учебные страницы. */
export function noteOwnerTurn(userId: string, text: string, o: OwnerTurn): void {
  if (!o.addressed) return;
  const now = o.now ?? Date.now();
  const t = text.trim();
  if (REVOKE.test(t)) {
    until.delete(userId);
    return;
  }
  if (EDU_TASK.test(t)) {
    until.set(userId, now + EDU_GRANT_MS);
    return;
  }
  if ((until.get(userId) ?? 0) > now && CONTINUE.test(t)) until.set(userId, now + EDU_GRANT_MS);
}

export function eduGrantActive(userId: string, now: number = Date.now()): boolean {
  return (until.get(userId) ?? 0) > now;
}

/**
 * Грант действует на этом месте? Только учебная LMS-страница по пути на хосте, который НЕ в списке опасных
 * (банк/мессенджер/маркетплейс…): «пройди тест» не разрешает нажать «Оплатить» на чужом сайте.
 */
export function eduGrantedAt(userId: string, place: { host?: string; url?: string }): boolean {
  if (!eduGrantActive(userId)) return false;
  if (place.host && riskyHostCategory(place.host)) return false;
  return isLmsPage(place.url ?? "");
}

/** Категория места (GUI-гейт браузера отдаёт её вместо адреса): грант — только на «edu». */
export function eduGrantedFor(userId: string, category: string | undefined): boolean {
  return category === "edu" && eduGrantActive(userId);
}

/** Сброс (тесты). */
export function resetTaskGrants(): void {
  until.clear();
}

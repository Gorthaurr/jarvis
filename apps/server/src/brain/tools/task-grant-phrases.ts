/**
 * Разбор ФРАЗ владельца для гранта «поручение = разрешение» (task-grant.ts): учебное поручение / продолжение / отзыв.
 * Чистые функции без состояния. Это эвристика по словам — осознанный ВРЕМЕННЫЙ слой (решает смысл регэкспами, а закон
 * проекта — «смысл решает модель»): потолок полномочий гранта держит код (task-grant.ts), а фразы заменит объявление
 * модели «вид гранта» в рамках, которые код не расширяет. Пока — консервативно: сомнение = грант не выдан = вопрос.
 */
const LETTER = "[\\p{L}\\p{N}]";
/** Корень слова с границами по буквам (JS `\b` кириллицу не знает). */
const word = (stem: string): string => `(?<!${LETTER})${stem}${LETTER}*`;
const exact = (w: string): string => `(?<!${LETTER})${w}(?!${LETTER})`;
const alt = (stems: readonly string[], f: (s: string) => string = word): string => stems.map(f).join("|");

// Однозначно «учебные» глаголы (и «курс» рядом с ними); прочие глаголы — только с однозначно учебными существительными.
const DO_STRONG = new RegExp(alt(["пройд", "пройти", "прош", "прохо[дж]", "прохожд", "заверш", "закончи"]), "giu");
const DO_OTHER = new RegExp(alt(["сда[йв]", "сдач", "сдать", "выполн", "реш[аиэ]", "решай", "отвеча", "ответь"]), "giu");
// «Сделай/делай» слишком общие («сделай потише», «сделай тест микрофона»): только с явной учёбой, без «тест/лекция/урок».
const DO_WEAK = new RegExp(alt(["делай", "сделай"]), "giu");
const NOUN_WORK = new RegExp(alt(["задани", "домашк", "лабораторн", "контрольн", "викторин", "квиз", "экзамен", "зач[её]т"]), "iu");
const NOUN_STUDY = new RegExp(alt(["тест", "задани", "домашк", "лабораторн", "контрольн", "викторин", "квиз", "экзамен", "зач[её]т", "лекци", "урок"]), "iu");
const NOUN_COURSE = new RegExp(word("курс"), "iu");
/** Слова «технической» жизни разработчика и денег: «выполни тесты в проекте», «курс доллара», «сделай тест микрофона». */
const NOT_STUDY = /микрофон|звук|скорост|интернет|доллар|евро|биткоин|валют|бирж|проект|сборк|билд|скриншот|автор[иі]зац|компил|npm|pnpm|vitest|git(?![\p{L}])/iu;
const QUESTIONISH = new RegExp(`^(?:${alt(["когда", "как", "зачем", "почему", "что", "где", "сколько", "напомни", "расскажи", "покажи", "найди", "объясни", "можно"], exact)})`, "iu");
const NEGATION = new RegExp(alt(["не", "нельзя", "запрещаю", "перестань", "прекрати", "хватит"], exact), "iu");
/** Граница клаузы: отрицание в ДРУГОЙ клаузе («не спрашивай разрешения, пройди тесты») глагола не касается. */
const CLAUSE_BREAK = new RegExp(`[,;:.!?—]|${alt(["и", "а", "но", "да", "потом", "зато"], exact)}`, "iu");
/** «Не забудь пройти» — просьба, а не запрет. */
const NOT_A_BAN = new RegExp(`${exact("не")}\\s+заб\\p{L}*`, "giu");

const stripWake = (t: string): string => t.replace(/^\s*(?:джарвис|джарвиз|жарвис)[\s,.!:—-]*/iu, "");

/** Фраза-поручение: «пройди все мини-тесты», «завершай курсы», «выполни задание» — не вопрос, не «не делай», не разработка. */
export function looksLikeStudyTask(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 300 || /\?\s*$/u.test(t) || QUESTIONISH.test(stripWake(t)) || NOT_STUDY.test(t)) return false;
  for (const s of t.split(/(?<=[.!?…])\s+/u)) {
    for (const [re, nouns, course] of [[DO_STRONG, NOUN_STUDY, true], [DO_OTHER, NOUN_STUDY, false], [DO_WEAK, NOUN_WORK, false]] as const) {
      for (const m of s.matchAll(re)) {
        const at = m.index ?? 0;
        const clause = s.slice(0, at).split(CLAUSE_BREAK).pop() ?? "";
        const before = clause.replace(NOT_A_BAN, " ").trim().split(/\s+/u).slice(-4).join(" ");
        if (NEGATION.test(before)) continue; // «не выполняй задание», «я не хочу, чтобы ты проходил тест»
        const near = s.slice(Math.max(0, at - 60), at + m[0].length + 60);
        if (nouns.test(near) || (course && NOUN_COURSE.test(near))) return true;
      }
    }
  }
  return false;
}

/** Короткое продолжение уже данного поручения: «иди», «давай», «да», «доделай». Продлевает, но не выдаёт. */
const CONTINUE = new RegExp(
  `^(?:джарвис[,.!\\s]*)?(?:${alt(["иди", "идём", "идем", "давай", "поехали", "погнали", "продолжай", "доделай", "дальше", "делай", "сдавай", "начинай", "вперёд", "вперед", "да", "ага", "угу", "хорошо", "ок", "окей"], exact)})(?:[\\s,.!]+(?:${alt(["иди", "давай", "дальше", "все", "всё", "пожалуйста", "сэр"], exact)}))*[\\s.!]*$`,
  "iu",
);
export const looksLikeContinue = (text: string): boolean => CONTINUE.test(text.trim());

// Отзыв. «Стоп/стой/хватит/заткнись» = «замолчи» (учебная задача идёт дальше) — сами по себе грант НЕ снимают. Снимают:
// «отмена/отмени/прекрати/остановись/вырубись» (всей репликой) и явное «не сдавай/не проходи…» / «стоп, не …».
const CANCEL_WORDS = alt(["отмена", "отмени", "отменяй", "прекрати", "остановись", "вырубись"], exact);
const STOP_WORDS = alt(["стоп", "стой", "хватит", "отмена", "отмени", "отменяй", "прекрати", "остановись", "вырубись", "заткнись"], exact);
const STOP_TAIL = alt(["все", "всё", "это", "тест\\S*", "задач\\S*", "пока", "сдавать", "проходить", "прохождение", "сейчас", "немедленно", "сэр", "джарвис"], exact);
const REVOKE_WHOLE = new RegExp(`^(?:джарвис[,.!\\s]*)?(?:${CANCEL_WORDS})(?:[\\s,.!]+(?:${STOP_TAIL}))*[\\s,.!]*$`, "iu");
const REVOKE_EXPLICIT = new RegExp(`${alt(["не\\s+(?:сдавай|проходи|начинай|трогай|делай|продолжай)"], exact)}`, "iu");
const REVOKE_LEAD = new RegExp(`^(?:джарвис[,.!\\s]*)?(?:${STOP_WORDS})[\\s,.!]+не(?![\\p{L}])`, "iu");

/** Явный запрет без отмены задач: «не сдавай», «стоп, не сдавай». */
export function looksLikeBan(text: string): boolean {
  const t = text.trim();
  return REVOKE_EXPLICIT.test(t) || REVOKE_LEAD.test(t);
}
/** Отзыв по тексту (обычный ход): отмена всей репликой или явный запрет. */
export function looksLikeRevoke(text: string): boolean {
  return REVOKE_WHOLE.test(text.trim()) || looksLikeBan(text);
}

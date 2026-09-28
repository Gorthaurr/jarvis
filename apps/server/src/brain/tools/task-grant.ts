/**
 * «Поручение = разрешение» для учебных систем (решение владельца 28.09: «пусть не спрашивает разрешение — войти в
 * учётку, начать тест, — если само задание это подразумевает»).
 *
 * §14 на LMS (`commit-lms.ts`) спрашивал КАЖДЫЙ «Пройти тест» / «Проверить» / «Отправить всё» — даже когда владелец
 * сам сказал «пройди все тесты». Теперь такая реплика владельца выдаёт СЕССИОННЫЙ грант: пока он жив, LMS-коммиты
 * (старт попытки, проверка, сдача) на учебной странице идут без вопроса. Остальное §14 не трогаем.
 *
 * Границы (ревью 28.09, H1): грант — на СОЧЕТАНИЕ «учебная страница × подпись LMS-коммита». Страница узнаётся по
 * ПУТИ разобранного http(s)-адреса (не по подстроке: `shop.example/pay?next=/mod/quiz/view.php` — не LMS), хост
 * вне списка опасных, вкладка известна; подпись кнопки обязана быть LMS-коммитом (`LMS_COMMIT_RE`/`LMS_TWO_STEP_RE`) —
 * «Оплатить», «Удалить», «Опубликовать» и безымянный Enter спрашивают как прежде даже на учебной странице.
 * Выдаёт ТОЛЬКО адресованная реплика владельца (`noteOwnerTurn`); машинные ходы грантом не пользуются.
 * Снимают: «стоп/отмени/хватит…» (и на уровне управления задачами, `revokeOnControl`), «не сдавай/не проходи…».
 */
import { riskyHostCategory } from "./commit-gate.js";
import { LMS_COMMIT_RE, LMS_TWO_STEP_RE, isLmsPage } from "./commit-lms.js";
import type { ToolContext } from "./dispatch.js";

/** Сколько живёт грант после последней реплики владельца (скользящее окно: «иди» продлевает). */
export const EDU_GRANT_MS = 3 * 60 * 60_000;
/** Абсолютный потолок от момента ВЫДАЧИ: «да/ок» до бесконечности грант не тянут. */
export const EDU_GRANT_CAP_MS = 8 * 60 * 60_000;

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
const NEGATION = new RegExp(alt(["не", "нельзя", "без", "запрещаю", "перестань", "прекрати", "хватит"], exact), "iu");

const stripWake = (t: string): string => t.replace(/^\s*(?:джарвис|джарвиз|жарвис)[\s,.!:—-]*/iu, "");

/** Фраза-поручение: «пройди все мини-тесты», «завершай курсы», «выполни задание» — не вопрос, не «не делай», не разработка. */
export function looksLikeStudyTask(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 300 || /\?\s*$/u.test(t) || QUESTIONISH.test(stripWake(t)) || NOT_STUDY.test(t)) return false;
  const sentences = t.split(/(?<=[.!?…])\s+/u);
  for (const s of sentences) {
    for (const [re, nouns, course] of [[DO_STRONG, NOUN_STUDY, true], [DO_OTHER, NOUN_STUDY, false], [DO_WEAK, NOUN_WORK, false]] as const) {
      for (const m of s.matchAll(re)) {
        const at = m.index ?? 0;
        const before = s.slice(0, at).trim().split(/\s+/u).slice(-4).join(" ");
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

/** Владелец останавливает: «стоп/хватит/отмени [всё/тест]» всей репликой ИЛИ явное «не сдавай/не проходи». «Отмени напоминание» — не отзыв. */
const STOP_WORDS = alt(["стоп", "стой", "хватит", "отмена", "отмени", "отменяй", "прекрати", "остановись", "вырубись", "заткнись"], exact);
const STOP_TAIL = alt(["все", "всё", "это", "тест\\S*", "задач\\S*", "пока", "сдавать", "проходить", "прохождение", "сейчас", "немедленно", "сэр", "джарвис"], exact);
const REVOKE_WHOLE = new RegExp(`^(?:джарвис[,.!\\s]*)?(?:${STOP_WORDS})(?:[\\s,.!]+(?:${STOP_TAIL}))*[\\s,.!]*$`, "iu");
const REVOKE_EXPLICIT = new RegExp(`${alt(["не\\s+(?:сдавай|проходи|начинай|трогай|делай|продолжай)"], exact)}`, "iu");
/** «Стоп, не сдавай тест»: слово остановки в начале + продолжение — тоже отзыв. */
const REVOKE_LEAD = new RegExp(`^(?:джарвис[,.!\\s]*)?(?:${STOP_WORDS})[\\s,.!]+не(?![\\p{L}])`, "iu");

export function looksLikeRevoke(text: string): boolean {
  const t = text.trim();
  return REVOKE_WHOLE.test(t) || REVOKE_EXPLICIT.test(t) || REVOKE_LEAD.test(t);
}

interface Grant {
  until: number;
  cap: number;
}
const grants = new Map<string, Grant>();

export interface OwnerTurn {
  /** Реплика адресована Джарвису («Джарвис…» / кнопка / окно разговора владельцу) — не фон и не машинный реэнтри. */
  addressed: boolean;
  now?: number;
}

/** Учесть реплику владельца: выдать/продлить/снять грант на учебные страницы. */
export function noteOwnerTurn(userId: string, text: string, o: OwnerTurn): void {
  if (!o.addressed) return;
  const now = o.now ?? Date.now();
  if (looksLikeRevoke(text)) {
    grants.delete(userId);
    return;
  }
  if (looksLikeStudyTask(text)) {
    grants.set(userId, { until: now + EDU_GRANT_MS, cap: now + EDU_GRANT_CAP_MS });
    return;
  }
  const g = grants.get(userId);
  if (g && g.until > now && CONTINUE.test(text.trim())) g.until = Math.min(now + EDU_GRANT_MS, g.cap);
}

/**
 * Отзыв на уровне управления задачами (ревью 28.09, H2): «отмени/вырубись/стоп» перехватывает `handleControlUtterance`
 * ДО `handleUserText` — туда реплика не доходит и отзыв не срабатывал бы ровно тогда, когда задача идёт.
 */
export function revokeOnControl(userId: string, text: string): void {
  if (looksLikeRevoke(text)) grants.delete(userId);
}

/** Безусловный отзыв (кнопка «стоп» в UI, полный стоп автономии). */
export function revokeTaskGrant(userId: string): void {
  grants.delete(userId);
}

export function eduGrantActive(userId: string, now: number = Date.now()): boolean {
  return (grants.get(userId)?.until ?? 0) > now;
}

type GrantCtx = Pick<ToolContext, "userId"> & Partial<Pick<ToolContext, "machineTurn" | "origin">>;
/** Грантом пользуется ход владельца; наблюдения/проактив (машинный ход) — нет. */
const ownerDriven = (ctx: GrantCtx): boolean => ctx.machineTurn !== true && ctx.origin !== "proactive";

/** Учебная страница по ПУТИ разобранного http(s)-адреса с хостом (подстрока в query/fragment/схемах data:/blob:/file: — нет). */
export function isLmsUrlStrict(url: string): boolean {
  try {
    const u = new URL(url);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname) return false;
    return isLmsPage(u.pathname);
  } catch {
    return false;
  }
}

/** Подпись — LMS-коммит (старт попытки, проверка, сдача). Пусто/«Оплатить»/«Удалить» — нет. */
export function eduLabelOk(labels: string | readonly string[]): boolean {
  const list = typeof labels === "string" ? [labels] : labels;
  return list.some((s) => LMS_COMMIT_RE.test(s.trim()) || LMS_TWO_STEP_RE.test(s.trim()));
}

/** Подпись GUI-сигнатуры вида `click:<подпись>` — LMS-коммит? */
export function eduSignatureOk(signature: string): boolean {
  return signature.startsWith("click:") && eduLabelOk(signature.slice("click:".length));
}

/** Место: живой грант, ход владельца, известная вкладка на учебной странице (строго по пути) и хосте вне списка опасных. */
export function eduPlaceGranted(ctx: GrantCtx, place: { host?: string; url?: string; unknown?: boolean }): boolean {
  if (!ownerDriven(ctx) || !eduGrantActive(ctx.userId) || place.unknown === true) return false;
  if (!place.host || riskyHostCategory(place.host)) return false;
  return isLmsUrlStrict(place.url ?? "");
}

/** Грант на ЭТО действие браузера: учебная страница И подпись — LMS-коммит. */
export function eduGrantedAt(ctx: GrantCtx, place: { host?: string; url?: string; unknown?: boolean }, label: string | readonly string[]): boolean {
  return eduLabelOk(label) && eduPlaceGranted(ctx, place);
}

/** Грант на GUI-действия в окне Chrome (`browserPlace`): категория edu, строгий адрес вкладки, каждая сигнатура — LMS-коммит. */
export function eduGuiGranted(ctx: GrantCtx, place: { category?: string; host?: string; url?: string }, signatures: readonly string[]): boolean {
  if (place.category !== "edu" || signatures.length === 0 || !signatures.every(eduSignatureOk)) return false;
  return eduPlaceGranted(ctx, { host: place.host, url: place.url });
}

/** Сброс (тесты). */
export function resetTaskGrants(): void {
  grants.clear();
}

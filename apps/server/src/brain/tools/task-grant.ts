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
import { COMMIT_WORDS_RE } from "@jarvis/shared";
import { riskyHostCategory } from "./commit-gate.js";
import { LMS_COMMIT_RE, LMS_TWO_STEP_RE, isLmsPage } from "./commit-lms.js";
import type { ToolContext } from "./dispatch.js";
import { looksLikeBan, looksLikeContinue, looksLikeRevoke, looksLikeStudyTask } from "./task-grant-phrases.js";

export { looksLikeRevoke, looksLikeStudyTask };

/** Сколько живёт грант после последней реплики владельца (скользящее окно: «иди» продлевает). */
export const EDU_GRANT_MS = 3 * 60 * 60_000;
/** Абсолютный потолок от момента ВЫДАЧИ: «да/ок» до бесконечности грант не тянут. */
export const EDU_GRANT_CAP_MS = 8 * 60 * 60_000;

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
  if (g && g.until > now && looksLikeContinue(text)) g.until = Math.min(now + EDU_GRANT_MS, g.cap);
}

/**
 * Явный запрет на уровне управления задачами (ревью 28.09, H2): «не сдавай…» / «стоп, не сдавай» перехватывает
 * `handleControlUtterance` ДО `handleUserText`. Отмена/«вырубись»/«тишина»/ложный запуск снимают грант в местах, где
 * задачи реально отменяются (`revokeTaskGrant` рядом с `cancelUser`); голое «стоп» = «замолчи» — грант живёт.
 */
export function revokeOnControl(userId: string, text: string): void {
  if (looksLikeBan(text)) grants.delete(userId);
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

/**
 * Подпись — ЦЕЛИКОМ LMS-коммит (регэксп LMS неякорный: «Оплатить и пройти тест» тоже совпал бы). Допустимы хвосты Moodle:
 * «(сейчас)», «now», многоточие.
 */
const LMS_ANCHORED = new RegExp(`^\\s*(?:${LMS_COMMIT_RE.source}|${LMS_TWO_STEP_RE.source})(?:\\s*\\([^)]{0,30}\\))?(?:\\s+(?:сейчас|now))?\\s*[.…]*\\s*$`, "iu");

/**
 * Подписи цели — LMS-коммит: хотя бы одна подпись целиком LMS-фраза, и НИ ОДНА другая не похожа на коммит вне LMS
 * («Удалить работу» из снимка при имени модели «Отправить на проверку» — нет). Пусто — нет.
 */
export function eduLabelOk(labels: string | readonly string[]): boolean {
  const list = (typeof labels === "string" ? [labels] : labels).map((l) => l.trim()).filter(Boolean);
  if (list.length === 0 || !list.some((l) => LMS_ANCHORED.test(l))) return false;
  return list.every((l) => LMS_ANCHORED.test(l) || !COMMIT_WORDS_RE.test(l));
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

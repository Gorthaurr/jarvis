/**
 * W2 (пакет 0, решение №2): КОММИТ ПО ЭЛЕМЕНТУ — что нажимается, а не как оно подписано в запросе.
 *
 * В мессенджере/банке/ЭДО безопасных целей мало и они перечислимы: поле, документ, вкладка, дерево, полоса прокрутки,
 * пункт списка с буквенным именем (чат «Катя»), навигационные кнопки (назад/отмена/закрыть/поиск/меню/настройки).
 * Всё прочее — коммит с подписью «click:<имя>» (безымянное — «click:?<роль>»): «Отпр», «➤», «×», безымянная
 * иконка самолётика денилист глаголов не узнавал. В браузере и прочих рискованных категориях — по глаголам
 * `COMMIT_WORDS_RE` (там allowlist дал бы вопрос на каждую ссылку). Удалённый доступ — только клавиши.
 */
import { COMMIT_WORDS_RE, type GuiCategory } from "./commit-risk.js";
import { commitSignature, foldLabel, normRole } from "./commit-signature.js";

/** Факты об элементе (из снапшота, ground.at, фокуса): имя — реальное, не текст запроса. */
export interface ElementFacts {
  role?: string;
  name?: string;
}

/** Категории, где коммит задаётся allowlist'ом безопасных целей. */
const ALLOWLIST_CATEGORIES: ReadonlySet<string> = new Set(["messenger", "bank", "edo"]);

/** Роли, нажатие на которые ничего не отправляет (фокус поля, переключение вкладки, раскрытие ветки, прокрутка). */
const SAFE_ROLES: ReadonlySet<string> = new Set(["edit", "document", "tabitem", "treeitem", "scrollbar"]);

/** Навигационные кнопки и пункты меню (имя целиком). Данные — правятся после смоука. */
export const SAFE_NAV_RE =
  /^(?:назад|отмена|отменить|закрыть|поиск|найти|меню|настройки|свернуть|развернуть|back|cancel|close|search|find|menu|settings|minimi[sz]e|maximi[sz]e)$/iu;

/** select/toggle: переключатель тоже бывает коммитом — «переслать», «поделиться», «позвонить». */
const EXTENDED_COMMIT_RE = /(?<![\p{L}])(?:пересл|forward|подел|share|позвон|call\b)/iu;
/** Подтверждение диалога в банке/ЭДО («Да», «ОК», «Продолжить») — само по себе проводит операцию. */
const CONFIRM_RE = /^(?:да|ок|ok|продолжить|yes|continue)$/iu;

/** Глаголы-нажатия (судятся как клик по элементу). Правый клик открывает меню — не коммит. */
const PRESS_VERBS: ReadonlySet<string> = new Set(["click", "invoke", "double", "triple", "middle", "drag", "down"]);

/** Пункт списка с буквенным именем (чат, контакт, папка): эмодзи/цифры/пусто — нет. */
const lettered = (name: string): boolean => /\p{L}{2,}/u.test(name);

/**
 * Подпись коммита для действия `verb` над элементом `el` в процессе категории `category`; null — не коммит.
 * category null — процесс не рискованный: элементы не судятся (как и прежде).
 */
export function elementCommit(el: ElementFacts, category: GuiCategory | null, verb: string): string | null {
  if (!category || category === "remote") return null;
  const name = foldLabel(el.name);
  const role = normRole(el.role);
  const sig = (): string => commitSignature({ name: el.name, role: el.role });
  if (verb === "select" || verb === "toggle") {
    const hit = COMMIT_WORDS_RE.test(name) || EXTENDED_COMMIT_RE.test(name) || ((category === "bank" || category === "edo") && CONFIRM_RE.test(name));
    return hit ? sig() : null;
  }
  if (!PRESS_VERBS.has(verb)) return null;
  if (!ALLOWLIST_CATEGORIES.has(category)) return name && COMMIT_WORDS_RE.test(name) ? sig() : null;
  if (SAFE_ROLES.has(role)) return null;
  if (role === "listitem" && lettered(name)) return null;
  if ((role === "button" || role === "menuitem") && SAFE_NAV_RE.test(name)) return null;
  return sig();
}

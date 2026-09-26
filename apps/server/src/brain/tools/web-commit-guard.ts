/**
 * §14 для browser_act/browser_batch, часть 2 (боевой прогон 26.09, Moodle).
 *
 * 1. ДЫРА: действие по tabId без url (так велит персона после browser_tabs) судилось по host="" → гейт молчал на ЛЮБОМ
 *    сайте, включая банки и мессенджеры. Теперь адрес вкладки берём у расширения (tab.list); не узнали — судим строго.
 * 2. Клик по селектору/ref сервер судить не мог (подписи не видно). На опасном месте отдаём странице guard — регэксп
 *    глаголов коммита; расширение сверяет подпись РЕАЛЬНОГО элемента и, если похоже на коммит, не жмёт, а возвращает
 *    commit_confirm с подписью. Спрашиваем владельца и повторяем с guardApproved — флаг ставит только сервер.
 * 3. Moodle сдаёт тест в два шага одной подписью («Отправить всё и завершить тест» → окно с той же кнопкой): на
 *    учебной странице одобрение той же подписи держится 60 с, второй вопрос подряд не задаём.
 */
import { COMMIT_WORDS_RE } from "@jarvis/shared";
import type { ToolContext, ToolResult } from "./dispatch.js";
import { confirmDeclineText, err, gateDeclined } from "./dispatch-util.js";
import { type CommitRisk, hostOfUrl } from "./commit-gate.js";
import { LMS_COMMIT_RE, LMS_TWO_STEP_RE, isLmsPage } from "./commit-lms.js";

export interface WebPlace {
  url: string;
  host: string;
  /** Адрес вкладки не определён — судим как опасное место (fail-closed). */
  unknown: boolean;
  /** Вкладка, которую выберет расширение (её же и судили) — действие шлём ТОЧНО в неё. */
  tabId?: number;
}

interface ListedTab {
  tabId?: unknown;
  url?: unknown;
  active?: unknown;
}

/**
 * Какую вкладку возьмёт расширение (зеркало modules/tab-find.js findTargetTab): живой tabId, если его хост совпал с
 * хостом цели (или хоста у цели нет, или вкладка ещё без адреса); иначе вкладка по хосту цели (активная, иначе первая).
 * Ревью 26.09 (HIGH): гейт судил вкладку по tabId, а расширение при несовпадении хоста жало в ДРУГУЮ вкладку по хосту —
 * «Перевести» в банке уходило без вопроса, пока tabId указывал на ушедшую на example.org вкладку.
 */
function chooseTab(tabs: ListedTab[], target: { url: string; tabId?: number }): ListedTab | undefined {
  const host = hostOfUrl(target.url);
  const urlOf = (t: ListedTab): string => (typeof t.url === "string" ? t.url : "");
  if (target.tabId !== undefined) {
    const t = tabs.find((x) => x.tabId === target.tabId);
    if (t && (!host || !urlOf(t) || hostOfUrl(urlOf(t)) === host)) return t;
  }
  if (!host) return undefined; // активную вкладку «последнего окна» список не различает — пусть будет «неизвестно»
  const matches = tabs.filter((x) => hostOfUrl(urlOf(x)) === host);
  return matches.find((x) => x.active === true) ?? matches[0];
}

/**
 * Место для гейта — ЖИВОЙ адрес той вкладки, где расширение реально нажмёт (запомненный url из browser_open протухает:
 * тест Moodle идёт view → attempt → summary кликами, а учебную страницу узнаём именно по пути). Не узнали — «неизвестно».
 */
export async function resolvePlace(ctx: ToolContext, target: { url: string; tabId?: number }): Promise<WebPlace> {
  if (!ctx.ext?.tabList) return { url: target.url, host: hostOfUrl(target.url), unknown: !hostOfUrl(target.url) };
  try {
    const list = (await ctx.ext.tabList()) as { tabs?: ListedTab[] } | undefined;
    const tab = chooseTab(list?.tabs ?? [], target);
    // Вкладки этого хоста нет — расширение само честно упадёт «нет вкладки», судим по хосту цели (как раньше).
    // «Неизвестно» — только когда хоста нет: тогда расширение возьмёт АКТИВНУЮ вкладку, какую — не знаем.
    if (!tab || typeof tab.tabId !== "number") {
      const host = hostOfUrl(target.url);
      return host ? { url: target.url, host, unknown: false } : { url: "", host: "", unknown: true };
    }
    const url = typeof tab.url === "string" ? tab.url : "";
    return { url, host: hostOfUrl(url), unknown: !hostOfUrl(url), tabId: tab.tabId };
  } catch {
    return { url: "", host: "", unknown: true }; // расширение не ответило — судим строго
  }
}

/** Регэксп подписи-коммита для проверки на странице: только для опасного/учебного/неизвестного места. */
export function pageGuardFor(place: WebPlace, riskyHost: boolean): string | undefined {
  // Неизвестная вкладка может оказаться и LMS (мёртвый tabId → расширение берёт активную) — учебные слова тоже.
  if (isLmsPage(place.url) || place.unknown) return `${COMMIT_WORDS_RE.source}|${LMS_COMMIT_RE.source}`;
  if (riskyHost) return COMMIT_WORDS_RE.source;
  return undefined;
}

/** Подпись из ошибки расширения «commit_confirm: <подпись>» (элемент похож на коммит, клика не было). */
export function commitConfirmLabel(msg: string): string | null {
  const m = /commit_confirm:\s*(.*)$/su.exec(msg);
  return m ? m[1]!.trim() : null;
}

// Ревью 26.09 (HIGH): окно было многоразовым и привязанным к хосту — одно «да» на «Проверить» у вопроса 1 пропускало
// «Проверить» у вопроса 2, пустая подпись submit — любой submit хоста. Теперь только связка двухшаговой сдачи
// (та же страница, та же подпись сдачи), ОДИН раз.
const APPROVAL_WINDOW_MS = 60_000;
const approvals = new WeakMap<object, { page: string; label: string; at: number }>();
const fold = (s: string): string => s.toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
const pageOf = (url: string): string => url.split("#")[0] ?? "";

function takeApproval(ctx: ToolContext, place: WebPlace, label: string): boolean {
  const sess = ctx.session as unknown as object | undefined;
  const a = sess ? approvals.get(sess) : undefined;
  if (!a || !sess || a.page !== pageOf(place.url) || a.label !== fold(label) || Date.now() - a.at >= APPROVAL_WINDOW_MS) return false;
  approvals.delete(sess);
  return true;
}

function rememberApproval(ctx: ToolContext, place: WebPlace, label: string): void {
  const sess = ctx.session as unknown as object | undefined;
  if (sess && isLmsPage(place.url) && LMS_TWO_STEP_RE.test(label)) approvals.set(sess, { page: pageOf(place.url), label: fold(label), at: Date.now() });
}

/**
 * Спросить владельца про коммит (или пропустить, если та же учебная подпись одобрена только что). true — можно
 * жать; ToolResult — отказ/нет канала (вернуть модели как есть).
 */
export async function confirmWebCommit(ctx: ToolContext, place: WebPlace, risk: Pick<CommitRisk, "summary" | "what" | "where">, label: string): Promise<true | ToolResult> {
  if (takeApproval(ctx, place, label)) return true;
  if (!ctx.confirm) return err(`${risk.summary} Нужно подтверждение владельца (§14), а канал недоступен.`);
  const gate = await ctx.confirm(`${risk.summary}\nПодтвердить?`, "irreversible");
  if (!gate.approved) return gateDeclined(confirmDeclineText(gate.outcome, `${risk.what} на ${risk.where}`), gate.outcome);
  rememberApproval(ctx, place, label);
  return true;
}

/**
 * Риск по подписи, которую вернула страница (commit_confirm). Подпись задаёт САМА страница: владельцу в модалке её
 * показываем (он человек, ему надо видеть, что жмём), а в ответ модели (`what` уходит в текст отказа) — нет (M11).
 */
export function pageCommitRisk(place: WebPlace, label: string): Pick<CommitRisk, "summary" | "what" | "where"> {
  const where = place.host || "неизвестной вкладке";
  const shown = label.replace(/[<>]/gu, " ").slice(0, 60);
  const kind = isLmsPage(place.url) ? "учебная система — тест/задание" : place.unknown ? "сайт вкладки не определён" : "опасный сайт";
  return { where, what: "клик по кнопке-коммиту (подпись показана владельцу)", summary: `Необратимое действие в браузере (${kind}): клик «${shown}» на ${where}.` };
}

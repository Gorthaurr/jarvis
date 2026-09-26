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
import { LMS_COMMIT_RE, isLmsPage } from "./commit-lms.js";

export interface WebPlace {
  url: string;
  host: string;
  /** Адрес вкладки не определён — судим как опасное место (fail-closed). */
  unknown: boolean;
}

/**
 * Адрес вкладки для гейта: ЖИВОЙ адрес по tabId из расширения (запомненный url из browser_open протухает — тест Moodle
 * идёт view → attempt → summary кликами, а учебную страницу узнаём именно по пути) → url цели → «неизвестно».
 */
export async function resolvePlace(ctx: ToolContext, target: { url: string; tabId?: number }): Promise<WebPlace> {
  let url = target.url;
  if (target.tabId !== undefined && ctx.ext?.tabList) {
    try {
      const list = (await ctx.ext.tabList()) as { tabs?: Array<{ tabId?: unknown; url?: unknown }> } | undefined;
      const tab = list?.tabs?.find((t) => t.tabId === target.tabId);
      if (typeof tab?.url === "string") url = tab.url;
    } catch {
      /* расширение не ответило — останемся «неизвестно», гейт судит строго */
    }
  }
  const host = hostOfUrl(url);
  return { url, host, unknown: !host };
}

/** Регэксп подписи-коммита для проверки на странице: только для опасного/учебного/неизвестного места. */
export function pageGuardFor(place: WebPlace, riskyHost: boolean): string | undefined {
  if (isLmsPage(place.url)) return `${COMMIT_WORDS_RE.source}|${LMS_COMMIT_RE.source}`;
  if (riskyHost || place.unknown) return COMMIT_WORDS_RE.source;
  return undefined;
}

/** Подпись из ошибки расширения «commit_confirm: <подпись>» (элемент похож на коммит, клика не было). */
export function commitConfirmLabel(msg: string): string | null {
  const m = /commit_confirm:\s*(.*)$/su.exec(msg);
  return m ? m[1]!.trim() : null;
}

const APPROVAL_WINDOW_MS = 60_000;
const approvals = new WeakMap<object, { host: string; label: string; at: number }>();
const fold = (s: string): string => s.toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();

function approvedRecently(ctx: ToolContext, place: WebPlace, label: string): boolean {
  const sess = ctx.session as unknown as object | undefined;
  const a = sess ? approvals.get(sess) : undefined;
  return Boolean(a && isLmsPage(place.url) && a.host === place.host && a.label === fold(label) && Date.now() - a.at < APPROVAL_WINDOW_MS);
}

function rememberApproval(ctx: ToolContext, place: WebPlace, label: string): void {
  const sess = ctx.session as unknown as object | undefined;
  if (sess) approvals.set(sess, { host: place.host, label: fold(label), at: Date.now() });
}

/**
 * Спросить владельца про коммит (или пропустить, если та же учебная подпись одобрена только что). true — можно
 * жать; ToolResult — отказ/нет канала (вернуть модели как есть).
 */
export async function confirmWebCommit(ctx: ToolContext, place: WebPlace, risk: Pick<CommitRisk, "summary" | "what" | "where">, label: string): Promise<true | ToolResult> {
  if (approvedRecently(ctx, place, label)) return true;
  if (!ctx.confirm) return err(`${risk.summary} Нужно подтверждение владельца (§14), а канал недоступен.`);
  const gate = await ctx.confirm(`${risk.summary}\nПодтвердить?`, "irreversible");
  if (!gate.approved) return gateDeclined(confirmDeclineText(gate.outcome, `${risk.what} на ${risk.where}`), gate.outcome);
  rememberApproval(ctx, place, label);
  return true;
}

/** Риск по подписи, которую вернула страница (commit_confirm): для модалки владельцу. */
export function pageCommitRisk(place: WebPlace, label: string): Pick<CommitRisk, "summary" | "what" | "where"> {
  const where = place.host || "неизвестной вкладке";
  const what = `клик «${label.slice(0, 60)}»`;
  const kind = isLmsPage(place.url) ? "учебная система — тест/задание" : place.unknown ? "сайт вкладки не определён" : "опасный сайт";
  return { where, what, summary: `Необратимое действие в браузере (${kind}): ${what} на ${where}.` };
}

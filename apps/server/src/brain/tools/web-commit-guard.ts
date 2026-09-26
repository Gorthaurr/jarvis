/**
 * §14 для browser_act/browser_batch, часть 2 (боевой прогон 26.09, Moodle). Где судим — `web-place.ts`.
 *
 * 1. Клик по селектору/ref сервер судить не мог (подписи не видно). На ЛЮБОМ месте (W1) отдаём странице guard — регэксп
 *    глаголов коммита; расширение сверяет подпись РЕАЛЬНОГО элемента и, если похоже на коммит, не жмёт, а возвращает
 *    commit_confirm с подписью. Спрашиваем владельца и повторяем с guardApproved + approvedLabel (флаги ставит только
 *    сервер; страница сверит, что жмёт ту самую подпись).
 * 2. Moodle сдаёт тест в два шага одной подписью («Отправить всё и завершить тест» → окно с той же кнопкой): одно «да»
 *    на эту связку — один раз, та же страница, 60 с.
 */
import { COMMIT_WORDS_RE } from "@jarvis/shared";
import type { ToolContext, ToolResult } from "./dispatch.js";
import { confirmDeclineText, err, gateDeclined } from "./dispatch-util.js";
import { type CommitRisk, riskyHostCategory, webCommitLabelParts } from "./commit-gate.js";
import { LMS_COMMIT_RE, LMS_TWO_STEP_RE, isLmsPage } from "./commit-lms.js";
import type { WebPlace } from "./web-place.js";

export { resolvePlace, type WebPlace } from "./web-place.js";

/**
 * Регэксп подписи-коммита для проверки на странице — на ЛЮБОМ хосте (W1, B-5): список опасных хостов неполон, и
 * «Оплатить»/«Опубликовать»/«Удалить навсегда» по селектору/ref на незнакомом сайте раньше не судил никто. Список
 * хостов на сервере лишь добавляет свой суд (Enter в мессенджере, клик по тексту на банке).
 */
export function pageGuardFor(place: WebPlace): string {
  // Неизвестная вкладка может оказаться и LMS (мёртвый tabId → расширение берёт активную) — учебные слова тоже.
  if (isLmsPage(place.url) || place.unknown) return `${COMMIT_WORDS_RE.source}|${LMS_COMMIT_RE.source}`;
  return COMMIT_WORDS_RE.source;
}

/**
 * W1-2/W1-T3: подпись, к которой привязываем одобрение владельца, — из ТЕХ ЖЕ частей, по которым судили риск
 * (text/name/title/подпись ref; у type — подпись поля, не печатаемое). Пустая строка — подписи нет.
 */
export function commitApprovalLabel(intent: string, params: Record<string, unknown>, refHint?: string): string {
  return webCommitLabelParts(intent, params, refHint)[0]?.slice(0, 160) ?? "";
}

/**
 * Служебные поля одобрения: guardApproved ТОЛЬКО вместе с approvedLabel (страница сверит, что жмёт ту самую подпись).
 * Без подписи одобрения не шлём — страница, узнав коммит, спросит заново (commit_confirm), а не нажмёт что попало.
 */
export function approvalFields(label: string): Record<string, unknown> {
  const lbl = label.trim();
  return lbl ? { guardApproved: true, approvedLabel: lbl } : {};
}

/**
 * Подпись из отказа расширения commit_confirm (элемент похож на коммит, клика не было): новое расширение кладёт её в
 * `label` ошибки (мост, контракт W1 §7), старое — в текст «commit_confirm: <подпись>». Не commit_confirm → null.
 */
export function commitConfirmLabel(e: unknown): string | null {
  if (e && typeof e === "object") {
    const x = e as { code?: unknown; label?: unknown };
    if (x.code === "commit_confirm" && typeof x.label === "string") return x.label.trim();
  }
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
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
 * Спросить владельца про коммит (или пропустить, если та же связка сдачи одобрена только что). true — можно жать;
 * ToolResult — отказ/нет канала (вернуть модели как есть).
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
  // Гард уходит на любой хост (W1) — «опасный сайт» про обычный сайт было бы неправдой в модалке владельца.
  const kind = isLmsPage(place.url) ? "учебная система — тест/задание" : place.unknown ? "сайт вкладки не определён" : riskyHostCategory(place.host) ? "опасный сайт" : "сайт";
  return { where, what: "клик по кнопке-коммиту (подпись показана владельцу)", summary: `Необратимое действие в браузере (${kind}): клик «${shown}» на ${where}.` };
}

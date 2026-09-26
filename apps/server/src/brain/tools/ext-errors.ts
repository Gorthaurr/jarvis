/**
 * W1 «браузерные руки» (B-4, закон 1): ошибки моста к расширению — ЧТО именно не вышло.
 *
 * Три разных отказа моста раньше приходили одним `Error` и одинаково звались «Не вышло»:
 * - расширение не подключено / `socket.send` бросил — запрос НЕ ушёл: честный провал;
 * - таймаут или разрыв связи ПОСЛЕ отправки — запрос УШЁЛ, ответа нет: клик/ввод мог состояться. Звать это
 *   провалом значит толкнуть модель повторить (двойная отправка формы) или ткнуть по координатам.
 * Второй случай метится `code: "ext_no_reply"` — по нему хендлер отдаёт «исход неизвестен» (`uncertain`).
 *
 * Коды страницы (`secret_field`, `tab_closed`, `tab_not_visible`, `ref_stale`, `commit_confirm`…) доходят тремя
 * путями: `code` у ответа моста (новое расширение: `{id, ok:false, error, code, label}`), `code` в данных
 * (`tab.capture` резолвит `{ok:false, code}`) и токен в тексте ошибки (старое расширение:
 * `throw new Error("tab.act click: commit_confirm: …")`). Читаем все три.
 */

/** Запрос ушёл расширению, ответа нет (таймаут / расширение отключилось или переподключилось). */
export const EXT_NO_REPLY = "ext_no_reply";

export interface ExtError extends Error {
  code?: string;
  /** Подпись элемента от страницы (commit_confirm) — данные страницы (M11), только владельцу в модалку. */
  label?: string;
}

/** Ошибка «ответа нет» — ЕДИНСТВЕННЫЙ конструктор (мост и фикстуры тестов берут её отсюда). */
export function extNoReplyError(message: string): ExtError {
  const e: ExtError = new Error(message);
  e.code = EXT_NO_REPLY;
  return e;
}

/** Ошибка расширения с кодом/подписью из ответа (`{id, ok:false, error, code?, label?}`). */
export function extReplyError(message: string, code?: unknown, label?: unknown): ExtError {
  const e: ExtError = new Error(message);
  if (typeof code === "string" && code) e.code = code;
  if (typeof label === "string") e.label = label;
  return e;
}

/** Отправлено, но ответа нет → исход действия неизвестен. */
export function isExtNoReply(e: unknown): boolean {
  return Boolean(e) && typeof e === "object" && (e as ExtError).code === EXT_NO_REPLY;
}

/** Известные коды страницы — токеном в тексте их шлёт старое расширение. */
const PAGE_CODES = ["secret_field", "tab_closed", "tab_not_visible", "ref_stale", "commit_confirm", "not_found", "capture_failed", "ambiguous"] as const;
const CODE_TOKEN_RE = new RegExp(`(?<![\\p{L}\\p{N}_])(${PAGE_CODES.join("|")})(?![\\p{L}\\p{N}_])`, "u");

/** Код отказа страницы: из `code` ошибки/данных либо токеном из текста. Нет → undefined. */
export function pageErrorCode(e: unknown): string | undefined {
  if (e && typeof e === "object") {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string" && c && c !== EXT_NO_REPLY) return c;
  }
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return CODE_TOKEN_RE.exec(msg)?.[1];
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

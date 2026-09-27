/**
 * W2 П1 (безопасность №17, N-4): что мост SDK и реплей навыка могут ЗАПУСТИТЬ и ЗАКРЫТЬ.
 *
 * `app.launch`/`browser.open` уходят в ShellExecute: строка «skype:?call», «tg://resolve?…&text=…», «zoommtg:…»,
 * «mailto:…?body=…» — это не «открыть программу», а ДЕЙСТВИЕ в ней (звонок, отправка, вход в конференцию) мимо §14.
 * Allowlist: http/https-адрес или имя/путь программы (без схемы; буква диска — путь). Прочие схемы → отказ.
 * `app.close{force}` с моста — жёсткое убийство процесса (несохранённое теряется) без подтверждения владельца → отказ.
 */
import { ActionError } from "./action-error.js";

/** Схема URI в начале строки (`skype:`, `tg:`, `ms-settings:`); буква диска `C:` схемой не считается. */
const SCHEME_RE = /^\s*([a-z][a-z0-9+.-]*):/iu;
const WEB_RE = /^\s*https?:\/\//iu;

/** Причина отказа запуска (null — можно): имена программ и http/https — да, прочие схемы URI — нет. */
export function launchDenial(target: unknown, what: "app.launch" | "browser.open"): string | null {
  const s = String(target ?? "");
  if (WEB_RE.test(s)) return null;
  const m = SCHEME_RE.exec(s);
  const scheme = m?.[1] ?? "";
  if (what === "browser.open" && s.trim()) return `${what}: только http/https-адрес, а не «${s.slice(0, 40)}» — ничего не открыто`;
  if (!m || scheme.length === 1) return null; // имя программы или путь «C:\…»
  return `${what}: схема «${scheme}:» запускает действие в программе (звонок, отправка, вход) мимо подтверждения владельца — с моста/из навыка не открываю; для сайта — http/https, для программы — её имя`;
}

/** Реплей навыка: запуск вне allowlist — отказ `denied` (раннер его не ретраит). */
export function assertLaunchAllowed(target: unknown, what: "app.launch" | "browser.open"): void {
  const d = launchDenial(target, what);
  if (d) throw new ActionError(d, { code: "denied" });
}

/** app.close с моста: только штатное закрытие (как крестик), жёсткое — через сервер с подтверждением. */
export function closeDenial(cmd: { force?: unknown }): string | null {
  return cmd.force === true || cmd.force === "true"
    ? "app.close{force}: жёсткое закрытие теряет несохранённое — с моста SDK не делаю; закрой штатно (force=false) или через инструмент app_close"
    : null;
}

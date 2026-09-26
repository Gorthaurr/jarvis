/**
 * ГДЕ действует браузерная рука — для §14 (боевой прогон 26.09 + ревью). Гейт обязан судить ту же вкладку и тот же
 * адрес, где действие реально исполнится:
 * - расширение (browser_act/batch): по tabId без url гейт судил host="" и молчал на любом сайте, а при несовпадении
 *   хоста расширение жало в ДРУГУЮ вкладку по хосту — сервер повторяет выбор расширения и шлёт действие точно в неё;
 * - невидимый браузер (web_act): его act адреса не отдаёт, клик уводит страницу (курсы → тест) — адрес дочитываем.
 */
import type { ActionCommand } from "@jarvis/protocol";
import type { ToolContext } from "./dispatch.js";
import { hostOfUrl, rememberWebTarget } from "./commit-gate.js";

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
  status?: unknown;
}

/** Хост ровно как у расширения (modules/utils.js hostOf): .host с портом, без «www.», голый хост — с https. */
function extHost(u: string): string {
  try {
    return new URL(/^[a-z]+:\/\//iu.test(u) ? u : `https://${u}`).host.replace(/^www\./u, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Какую вкладку возьмёт расширение (зеркало modules/tab-find.js findTargetTab): живой tabId, если его хост совпал с
 * хостом цели (или хоста у цели нет, вкладка ещё без адреса или грузится); иначе вкладка по хосту цели (активная,
 * иначе первая). Хост сравниваем как расширение (www.); статус неизвестен при расхождении хостов — «неизвестно».
 */
function chooseTab(tabs: ListedTab[], target: { url: string; tabId?: number }): ListedTab | "unknown" | undefined {
  const host = extHost(target.url);
  const urlOf = (t: ListedTab): string => (typeof t.url === "string" ? t.url : "");
  if (target.tabId !== undefined) {
    const t = tabs.find((x) => x.tabId === target.tabId);
    const st = t && typeof t.status === "string" && t.status ? t.status : undefined;
    if (t && (!host || !urlOf(t) || extHost(urlOf(t)) === host || (st !== undefined && st !== "complete"))) return t;
    if (t && st === undefined) return "unknown"; // старое расширение без status: не знаем, чью вкладку возьмёт
  }
  if (!host) return undefined; // активную вкладку «последнего окна» список не различает — пусть будет «неизвестно»
  const matches = tabs.filter((x) => extHost(urlOf(x)) === host);
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
    if (tab === "unknown") return { url: "", host: "", unknown: true };
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

// Невидимый браузер (web_act): после act адрес помечаем протухшим; перед следующим действием-коммитом дочитываем.
const staleWeb = new WeakSet<object>();
export function markWebTargetStale(ctx: ToolContext): void {
  const sess = ctx.session as unknown as object | undefined;
  if (sess) staleWeb.add(sess);
}
export async function refreshWebTarget(ctx: ToolContext): Promise<void> {
  const sess = ctx.session as unknown as object | undefined;
  if (!sess || !staleWeb.has(sess)) return;
  staleWeb.delete(sess);
  try {
    const r = await ctx.session.sendAction({ kind: "jbrowser.read" } as ActionCommand, 15_000);
    const url = (r.data as { url?: unknown } | undefined)?.url;
    if (r.ok && typeof url === "string" && url) rememberWebTarget(sess, url);
  } catch {
    /* не дочитали — гейт судит по последнему известному адресу */
  }
}

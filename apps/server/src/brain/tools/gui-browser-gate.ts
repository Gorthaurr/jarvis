/**
 * W2 (П3, решение №4, поправка безопасности №2): БРАУЗЕР ЧЕРЕЗ GUI — категория web. Коммит в окне Chrome (act/клавиши
 * по живой вкладке, а не через browser_act) судится по ЖИВОЙ вкладке этого окна: расширение перечисляет вкладки
 * (`tabList`), окно — по заголовку (Chrome пишет в заголовок окна заголовок активной вкладки).
 *
 * - безопасный хост → грант без вопроса (Enter в поиске Google не дёргает владельца);
 * - рискованный хост (почта, банк, соцсеть…), учебная LMS по пути, неоднозначность (заголовок не совпал ни с одной
 *   активной вкладкой: другой профиль, инкогнито; заголовка нет) или расширение молчит → вопрос (web + хост).
 * Только Chrome: расширение живёт в нём; Edge/Firefox и прочие браузеры — всегда вопрос.
 */
import type { RiskCategory } from "@jarvis/shared";
import { categoryHuman, hostOfUrl, riskyHostCategory } from "./commit-gate.js";
import { isLmsPage } from "./commit-lms.js";
import type { ToolContext } from "./dispatch.js";

export interface BrowserPlace {
  /** Хост безопасный — грант без вопроса. */
  safe: boolean;
  /** Хост вкладки, по которой судили (для гранта и текста вопроса). */
  host?: string;
  category?: RiskCategory;
}

interface ListedTab {
  url?: unknown;
  title?: unknown;
  active?: unknown;
}

const TAB_LIST_MS = 4_000;
const fold = (s: unknown): string => String(s ?? "").toLowerCase().replace(/…$/u, "").replace(/\s+/gu, " ").trim();

/** Заголовок окна Chrome начинается с заголовка его активной вкладки (снимок режет заголовок до 50 символов). */
function sameTitle(windowTitle: string, tabTitle: unknown): boolean {
  const w = fold(windowTitle);
  const t = fold(tabTitle);
  const n = Math.min(w.length, t.length, 48);
  return n >= 3 && w.slice(0, n) === t.slice(0, n);
}

async function activeTabs(ctx: ToolContext): Promise<ListedTab[] | null> {
  if (!ctx.ext?.connected || !ctx.ext.tabList) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const silent = new Promise<null>((r) => (timer = setTimeout(() => r(null), TAB_LIST_MS)));
    const list = (await Promise.race([ctx.ext.tabList(), silent])) as { tabs?: ListedTab[] } | null;
    return Array.isArray(list?.tabs) ? list.tabs.filter((t) => t && t.active === true) : null;
  } catch {
    return null; // расширение молчит — судим строго
  } finally {
    clearTimeout(timer);
  }
}

/** Где в браузере нажмёт GUI-действие: `process` — канонический процесс, `title` — заголовок окна (если известен). */
export async function browserPlace(ctx: ToolContext, q: { process: string | null; title?: string }): Promise<BrowserPlace> {
  const unknown: BrowserPlace = { safe: false, category: "unknown" };
  if (q.process !== "chrome" || !q.title?.trim()) return unknown;
  const tabs = await activeTabs(ctx);
  if (!tabs) return unknown;
  const mine = tabs.filter((t) => sameTitle(q.title!, t.title));
  if (mine.length === 0) return unknown; // окно не из видимых расширению (другой профиль, инкогнито) — не знаем, где
  const judged = mine.map((t) => {
    const url = typeof t.url === "string" ? t.url : "";
    const host = hostOfUrl(url);
    const category: RiskCategory | null = !host ? "unknown" : (riskyHostCategory(host) ?? (isLmsPage(url) ? "edu" : null));
    return { host: host.replace(/^www\./u, ""), category };
  });
  const risky = judged.find((j) => j.category !== null);
  if (risky) return { safe: false, host: risky.host || undefined, category: risky.category ?? "unknown" };
  const hosts = [...new Set(judged.map((j) => j.host))];
  return { safe: true, ...(hosts.length === 1 ? { host: hosts[0] } : {}) };
}

/** Место в браузере для текста вопроса: «браузере (категория) на host». */
export function browserWhere(place: BrowserPlace): string {
  const cat = place.category ? ` (${categoryHuman(place.category)})` : "";
  return `браузере${cat} на ${place.host ?? "неизвестной вкладке"}`;
}

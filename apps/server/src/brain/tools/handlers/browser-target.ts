/**
 * Цель вкладки браузерной задачи (вынесено из browser.ts).
 *
 * W1-LOOP-4: цель жила ОДНА на сессию, а browser_act с W1 идёт без аренды ввода — две фоновые задачи сессии
 * исполнялись параллельно, и неявный act задачи A бил во вкладку, которую только что выбрала задача B. Теперь цель
 * запоминается ПО ЗАДАЧЕ (ключ — ToolContext: петля создаёт его один на задачу, makeToolCtx) и дублируется в сессию.
 * Своя цель задачи главнее; сессионная — только продолжение прошлой реплики («открой ютуб» → «включи»), когда эта
 * задача вкладку ещё не выбирала. WeakMap — ни контекст, ни сессию в памяти не держим.
 */
import type { ToolContext } from "../dispatch.js";
import { browserUrlBlocked } from "../dispatch-util.js";

export interface BrowserTarget {
  url: string;
  /** tabId из openOrFocus/browser_tabs — точное попадание + лечит гонку about:blank свежей вкладки. */
  tabId?: number;
  /** Когда выбрали (Date.now) — окно «активной веб-задачи» для блокировки мыши (см. inBrowserTask). */
  at?: number;
  /** P2.1: когда browser_act ЧЕСТНО не нашёл цель (canvas/WebGL — DOM пуст). Открывает окно, в котором
   *  координатный input_click разрешён как escape-hatch (зрение→клик по пикселям), а не глухо блокируется. */
  actMissedAt?: number;
}

const byTask = new WeakMap<object, BrowserTarget>();
const bySession = new WeakMap<object, BrowserTarget>();

/** Окно, в течение которого после browser_open считаем задачу «браузерной» и НЕ двигаем мышь. */
const BROWSER_TASK_WINDOW_MS = 90_000;
/** P2.1: окно после честного промаха browser_act, в котором координатный клик по canvas разрешён. */
const CANVAS_ESCAPE_WINDOW_MS = 30_000;

const sessOf = (ctx: ToolContext): object | undefined => ctx.session as unknown as object | undefined;

/** Запомнить выбранную вкладку: за задачей (главное) и за сессией (продолжение следующей репликой). */
export function rememberBrowserTarget(ctx: ToolContext, t: BrowserTarget): void {
  byTask.set(ctx, t);
  const sess = sessOf(ctx);
  if (sess) bySession.set(sess, t);
}

/** Текущая цель: своя цель задачи, иначе последняя цель сессии. */
export function currentBrowserTarget(ctx: ToolContext): BrowserTarget | undefined {
  const sess = sessOf(ctx);
  return byTask.get(ctx) ?? (sess ? bySession.get(sess) : undefined);
}

/** Идёт ли сейчас браузерная задача (был browser_open недавно) — тогда мышь (input_click) под запретом. */
export function inBrowserTask(ctx: ToolContext): boolean {
  const t = currentBrowserTarget(ctx);
  return Boolean(t && t.at !== undefined && Date.now() - t.at < BROWSER_TASK_WINDOW_MS);
}

/** P2.1: browser_act честно не справился (нет элемента/исключение/autoplay-гейт) — открыть окно координатного клика. */
export function markBrowserActMiss(ctx: ToolContext): void {
  const t = currentBrowserTarget(ctx);
  if (t) t.actMissedAt = Date.now();
}

/** P2.1: разрешён ли сейчас координатный input_click внутри браузерной задачи (окно короткое, само истекает). */
export function canvasClickAllowed(ctx: ToolContext): boolean {
  const t = currentBrowserTarget(ctx);
  return Boolean(t && t.actMissedAt !== undefined && Date.now() - t.actMissedAt < CANVAS_ESCAPE_WINDOW_MS);
}

/**
 * Цель вкладки: явный tabId из input (из browser_tabs — ТОЧНОЕ попадание) → явный url → запомненная → null (не бьём
 * вслепую). При явном tabId запоминаем цель — follow-up act/read на ТОЙ ЖЕ вкладке.
 */
export function resolveBrowserTarget(ctx: ToolContext, input: Record<string, unknown>): BrowserTarget | null {
  const explicit = String(input.url ?? "").trim();
  // §sec (H14): явный приватный/loopback/небезопасный url для act/read тоже отсекаем (как browser_open).
  if (explicit && browserUrlBlocked(explicit)) return null;
  const rawTab = input.tabId;
  const tabId = typeof rawTab === "number" ? rawTab : Number.parseInt(String(rawTab ?? ""), 10);
  if (Number.isFinite(tabId) && tabId > 0) {
    rememberBrowserTarget(ctx, { url: explicit, tabId, at: Date.now() });
    return { url: explicit, tabId };
  }
  if (explicit) return { url: explicit };
  return currentBrowserTarget(ctx) ?? null;
}

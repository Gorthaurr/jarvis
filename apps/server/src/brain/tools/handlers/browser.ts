/**
 * Хендлеры БРАУЗЕРНОГО домена (§6) — вынесено из god-object dispatch.ts (§ревью).
 * Действия в РЕАЛЬНЫХ вкладках пользователя через расширение (chrome.tabs/scripting); CDP-откат при отсутствии.
 * open/read/inspect/act/tabs/close + перенос логинов. Маршрутизация остаётся в dispatch (switch).
 */
import { type ActionCommand, DEFAULT_ACTION_TIMEOUT_MS, actionTimeoutMs } from "@jarvis/protocol";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { browserUrlBlocked, err, ok, untrusted } from "../dispatch-util.js";

/**
 * Цель браузерной задачи, запомненная per-сессия (WeakMap по объекту сессии — не держит сессию в памяти).
 */
interface BrowserTarget {
  url: string;
  /** tabId из openOrFocus — точное попадание + лечит гонку about:blank свежей вкладки. */
  tabId?: number;
  /** Когда открыли (Date.now) — окно «активной веб-задачи» для блокировки мыши (см. inBrowserTask). */
  at?: number;
  /** P2.1: когда browser_act ЧЕСТНО не нашёл цель (canvas/WebGL — DOM пуст). Открывает окно, в котором
   *  координатный input_click разрешён как escape-hatch (зрение→клик по пикселям), а не глухо блокируется. */
  actMissedAt?: number;
}
const browserTarget = new WeakMap<object, BrowserTarget>();

/** Окно, в течение которого после browser_open считаем задачу «браузерной» и НЕ двигаем мышь. */
const BROWSER_TASK_WINDOW_MS = 90_000;
/** P2.1: окно после честного промаха browser_act, в котором координатный клик по canvas разрешён. */
const CANVAS_ESCAPE_WINDOW_MS = 30_000;

/** Идёт ли сейчас браузерная задача (был browser_open недавно) — тогда мышь (input_click) под запретом. */
export function inBrowserTask(ctx: ToolContext): boolean {
  const sess = ctx.session as unknown as object | undefined;
  const t = sess ? browserTarget.get(sess) : undefined;
  return Boolean(t && t.at !== undefined && Date.now() - t.at < BROWSER_TASK_WINDOW_MS);
}

/** P2.1: пометить, что browser_act честно не справился (нет элемента/исключение/autoplay-гейт) — открыть
 *  окно для координатного клика. Так на canvas/видео модель не упирается в глухую блокировку мыши. */
export function markBrowserActMiss(ctx: ToolContext): void {
  const sess = ctx.session as unknown as object | undefined;
  if (!sess) return;
  const t = browserTarget.get(sess);
  if (t) t.actMissedAt = Date.now();
}

/** P2.1: разрешён ли сейчас координатный input_click внутри браузерной задачи (был недавний честный
 *  промах browser_act → DOM-путь исчерпан, нужен глаз+клик по пикселям). Окно короткое, само истекает. */
export function canvasClickAllowed(ctx: ToolContext): boolean {
  const sess = ctx.session as unknown as object | undefined;
  const t = sess ? browserTarget.get(sess) : undefined;
  return Boolean(t && t.actMissedAt !== undefined && Date.now() - t.actMissedAt < CANVAS_ESCAPE_WINDOW_MS);
}

/**
 * Цель вкладки: явный tabId из input (из browser_tabs — ТОЧНОЕ попадание) → явный url → запомненная из
 * browser_open → null (не бьём вслепую). При явном tabId запоминаем цель — follow-up act/read на ТОЙ ЖЕ вкладке.
 */
function resolveBrowserTarget(ctx: ToolContext, input: Record<string, unknown>): BrowserTarget | null {
  const explicit = String(input.url ?? "").trim();
  // §sec (H14): явный приватный/loopback/небезопасный url для act/read тоже отсекаем (как browser_open).
  if (explicit && browserUrlBlocked(explicit)) return null;
  const rawTab = input.tabId;
  const tabId = typeof rawTab === "number" ? rawTab : Number.parseInt(String(rawTab ?? ""), 10);
  if (Number.isFinite(tabId) && tabId > 0) {
    const sess = ctx.session as unknown as object | undefined;
    if (sess) browserTarget.set(sess, { url: explicit, tabId, at: Date.now() });
    return { url: explicit, tabId };
  }
  if (explicit) return { url: explicit };
  const sess = ctx.session as unknown as object | undefined;
  return (sess && browserTarget.get(sess)) ?? null;
}

/**
 * Открыть URL в браузере ПОЛЬЗОВАТЕЛЯ через расширение (§): есть вкладка сервиса → ФОКУС (не дубль),
 * нет → новая — в его сессии/логине. Расширение не подключено → откат на клиентский browser.open (inDefault, shell).
 */
export async function browserOpen(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const url = String(input.url ?? "").trim();
  if (!url) return err("browser_open: пустой url");
  if (browserUrlBlocked(url)) return err("browser_open: адрес заблокирован (внутренняя сеть/loopback/метаданные или небезопасная схема).");
  const sess = ctx.session as unknown as object | undefined;
  if (ctx.ext?.connected) {
    try {
      const r = (await ctx.ext.openOrFocus(url)) as { focused?: boolean; tabId?: number } | undefined;
      if (sess) browserTarget.set(sess, { url, tabId: r?.tabId, at: Date.now() }); // tabId → точное попадание act/read
      return ok(r?.focused ? `Уже было открыто — переключился на вкладку.` : `Открыл ${url}.`);
    } catch {
      /* расширение не сработало — откат ниже */
    }
  }
  const result = await ctx.session.sendAction({ kind: "browser.open", url, inDefault: true }, actionTimeoutMs("browser.open"));
  if (result.ok) {
    if (sess) browserTarget.set(sess, { url, at: Date.now() }); // shell-открытие: tabId нет, act/read найдут по хосту
    return ok(`Открыл ${url}.`);
  }
  return err(`Не вышло открыть ${url}: ${result.error?.message ?? result.error?.code ?? "ошибка"}`);
}

/**
 * Перечислить ОТКРЫТЫЕ вкладки браузера пользователя (§): чтобы понять, о КАКОЙ вкладке речь. Отдаёт
 * заголовки/хост/активна/звучит. Только через расширение (CDP видит лишь свой инстанс, не реальные вкладки).
 */
export async function browserTabs(ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.ext?.connected) {
    return err("browser_tabs: расширение браузера не подключено — список вкладок недоступен.");
  }
  try {
    const r = (await ctx.ext.tabList()) as
      | { tabs?: Array<{ tabId?: number; title?: string; host?: string; url?: string; active?: boolean; audible?: boolean }> }
      | undefined;
    const tabs = r?.tabs ?? [];
    if (!tabs.length) return ok("Открытых вкладок не видно.");
    const lines = tabs.map((t, i) => {
      const flags = [t.active ? "активна" : "", t.audible ? "♪ звук" : ""].filter(Boolean).join(", ");
      return `${i + 1}. [tabId ${t.tabId}] ${t.title || t.host || t.url || "?"}${flags ? ` (${flags})` : ""} — ${t.host || t.url || ""}`;
    });
    return ok(
      `Открытые вкладки (${tabs.length}):\n${lines.join("\n")}\n` +
        `Чтобы действовать в КОНКРЕТНОЙ вкладке — передай её tabId в browser_act/browser_read (точное попадание).`,
    );
  } catch (e) {
    return err(`Не смог получить список вкладок: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * §ПЕРЕНОС ЛОГИНОВ: выгрузить куки залогиненного Chrome пользователя (расширение отдаёт РАСШИФРОВАННЫМИ,
 * минуя app-bound encryption) и импортировать в НЕВИДИМЫЙ браузер Джарвиса (CDP setCookie). input.domains — опц.
 */
export async function syncLogins(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.ext?.connected) {
    return err("синхронизация логинов: расширение браузера не подключено (нужно для чтения кук твоего Chrome).");
  }
  const domains = Array.isArray(input.domains) ? (input.domains as string[]).map(String) : undefined;
  let cookies: Array<Record<string, unknown>>;
  try {
    const r = (await ctx.ext.exportCookies(domains)) as { ok?: boolean; count?: number; cookies?: Array<Record<string, unknown>> } | undefined;
    cookies = r?.cookies ?? [];
  } catch (e) {
    return err(`синхронизация логинов: расширение не отдало куки — ${e instanceof Error ? e.message : String(e)} (переподтверди право cookies в chrome://extensions).`);
  }
  if (!cookies.length) return err("синхронизация логинов: куки не получены (нет права cookies у расширения? переподтверди разрешения).");
  const res = await ctx.session.sendAction({ kind: "jbrowser.import_cookies", cookies } as ActionCommand, 30_000);
  if (!res.ok) return err(`синхронизация логинов: импорт в браузер Джарвиса не удался — ${res.error?.message ?? res.error?.code ?? "ошибка"}.`);
  const d = res.data as { set?: number; total?: number } | undefined;
  return ok(`Перенёс логины: ${d?.set ?? 0} из ${d?.total ?? cookies.length} кук в мой невидимый браузер. Теперь я залогинен там же, где ты — могу действовать на твоих аккаунтах без отдельного входа.`);
}

/**
 * Закрыть вкладку(и) браузера пользователя (§): по tabId (точно) → по хосту url (все вкладки сайта) → активную.
 */
export async function browserCloseTab(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.ext?.connected) return err("browser_close: расширение браузера не подключено — закрыть вкладку нельзя.");
  const url = String(input.url ?? "").trim() || undefined;
  const rawTab = input.tabId;
  const tabId = typeof rawTab === "number" ? rawTab : Number.parseInt(String(rawTab ?? ""), 10);
  try {
    const r = (await ctx.ext.tabClose(url, Number.isFinite(tabId) && tabId > 0 ? tabId : undefined)) as { closed?: number } | undefined;
    const n = r?.closed ?? 0;
    if (n <= 0) return err("Не нашёл такой вкладки — закрывать нечего.");
    return ok(n === 1 ? "Закрыл вкладку." : `Закрыл ${n} вкладки.`);
  } catch (e) {
    return err(`Не смог закрыть вкладку: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Прочитать ЦЕЛЕВУЮ вкладку браузера пользователя (tabId/хост из browser_open, не «активную»). Иначе CDP-откат. */
export async function browserRead(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (ctx.ext?.connected) {
    const target = resolveBrowserTarget(ctx, input);
    if (!target) return err("browser_read: сначала открой нужную страницу (browser_open) — иначе непонятно, какую вкладку читать.");
    try {
      const r = (await ctx.ext.tabRead(target.url, target.tabId)) as { title?: string; text?: string } | undefined;
      return untrusted(`вкладка ${target.url ?? "браузера"}`, `# ${r?.title ?? ""}\n${r?.text ?? ""}`.slice(0, 8000));
    } catch (e) {
      return err(`Не смог прочитать вкладку: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const result = await ctx.session.sendAction(
    { kind: "browser.read", selectorIntent: String(input.selectorIntent ?? "") },
    DEFAULT_ACTION_TIMEOUT_MS,
  );
  return result.ok ? ok(result.data !== undefined ? JSON.stringify(result.data) : "ok") : err(`browser.read не удалось: ${result.error?.message ?? ""}`);
}

/**
 * ГЛАЗА В DOM (§): снимок интерактивных элементов целевой вкладки с устойчивыми селекторами — чтобы модель
 * САМА видела реальную страницу и прицельно действовала browser_act{selector}. Нет цели → честная ошибка.
 */
export async function browserInspect(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.ext?.connected) return err("browser_inspect недоступен: расширение не подключено.");
  const target = resolveBrowserTarget(ctx, input);
  if (!target) return err("browser_inspect: сначала открой нужную страницу (browser_open) — непонятно, какую вкладку осматривать.");
  const query = String(input.query ?? "").trim() || undefined;
  const cap = typeof input.cap === "number" ? input.cap : undefined;
  try {
    const r = (await ctx.ext.tabInspect(target.url, query, cap, target.tabId)) as
      | { url?: string; title?: string; count?: number; truncated?: boolean; elements?: unknown[] }
      | undefined;
    return untrusted(`DOM вкладки ${r?.url ?? target.url ?? ""}`, JSON.stringify({ url: r?.url, title: r?.title, count: r?.count, truncated: r?.truncated, elements: r?.elements ?? [] }));
  } catch (e) {
    return err(`Не смог осмотреть вкладку: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Действие В вкладке браузера пользователя (play/pause/next/click/type/scroll) через расширение
 * (chrome.scripting в реальной залогиненной вкладке). Нет цели → ЧЕСТНАЯ ошибка, не бьём вслепую. Иначе CDP-откат.
 */
export async function browserAct(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const intent = String(input.intent ?? "").trim();
  if (!intent) return err("browser_act: нужен intent (play|pause|seek|next|prev|click|type|enter|submit|scroll)");
  const params = input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : input;
  if (ctx.ext?.connected) {
    const target = resolveBrowserTarget(ctx, input);
    if (!target) return err(`browser_act: сначала открой нужную страницу (browser_open) — непонятно, в какой вкладке делать «${intent}».`);
    try {
      // ЧЕСТНОСТЬ: пробрасываем исход расширения (autoplayBlocked/navigated/already/playing/currentTime) —
      // иначе модель не видит, что play НЕ дал звук (autoplay-гейт), и врёт «готово, играет».
      const r = ((await ctx.ext.tabAct(target.url, intent, params, target.tabId)) ?? {}) as {
        autoplayBlocked?: boolean;
        note?: string;
        navigated?: unknown;
        already?: boolean;
        playing?: boolean;
        currentTime?: number;
        error?: string;
      };
      if (r.autoplayBlocked) {
        markBrowserActMiss(ctx); // P2.1: DOM-клик не дал звук → разрешаем координатный клик по вкладке
        return err(
          `browser_act «${intent}»: браузер ЗАБЛОКИРОВАЛ автоплей — звук НЕ пошёл. Нужен живой клик по вкладке: ` +
            `screen_capture → найди элемент глазами → input_click по координатам → ПЕРЕСНИМИ и сверь. НЕ говори «играет».`,
        );
      }
      const diagObj: Record<string, unknown> = {};
      for (const k of ["note", "navigated", "already", "playing", "currentTime"] as const) {
        if (r[k] !== undefined) diagObj[k] = r[k];
      }
      const diag = Object.keys(diagObj).length ? ` Результат: ${JSON.stringify(diagObj)}` : "";
      return ok(`Сделал «${intent}» в браузере.${diag}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markBrowserActMiss(ctx); // P2.1: DOM-путь исчерпан (нет элемента/исключение) → разрешаем координатный клик
      // НЕ откатываемся на системную медиа-клавишу (глобальный тумблер уходит чужой медиа-сессии). Честная ошибка.
      return err(
        `Не вышло «${intent}» на странице: ${msg}. Возможно, это canvas/видео без DOM-кнопки — тогда: ` +
          `screen_capture → найди цель глазами → input_click по координатам → ПЕРЕСНИМИ и сверь исход.`,
      );
    }
  }
  const command = { kind: "browser.act", intent, params } as unknown as ActionCommand;
  const result = await ctx.session.sendAction(command, DEFAULT_ACTION_TIMEOUT_MS);
  return result.ok ? ok(`Сделал: ${intent}.`) : err(`browser.act не удалось: ${result.error?.message ?? ""}`);
}

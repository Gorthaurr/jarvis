/**
 * Общее для кейсов web_* / browser_*: страницы «интернета» (seed.web), мок расширения Chrome с журналом обращений,
 * «ПК» с отказами клиента и вопрос-с-проверкой-текста. Мок и «ПК» создаются на КАЖДЫЙ запуск кейса (`rigCase`), поэтому
 * журнал обращений не течёт между кейсами и повторный прогон в одном процессе честен.
 */
import type { ActionCommand, ActionResult } from "../../../../packages/protocol/src/index.js";
import type { ToolContext } from "../../../../apps/server/src/brain/tools/dispatch.js";
import { createFakeDesktop } from "../../desktop/index.js";
import type { ConfirmPolicy, DesktopSeed, FakeDesktop } from "../../lib/contracts.js";
import type { ToolCase } from "../case-format.js";

export type Lab = NonNullable<ToolCase["lab"]>;
type Fn = (...a: never[]) => unknown;
export interface ExtCall { m: string; args: unknown[] }
export type ExtScript = { connected?: boolean } & Partial<Record<"openOrFocus" | "tabRead" | "tabInspect" | "tabAct" | "tabBatch" | "tabCapture" | "tabList" | "tabClose" | "exportCookies", Fn>>;

/** Мок расширения: каждый вызов пишется в `calls`; метод, которого сценарий не задал, падает — лишнее обращение видно. */
export function extRig(script: ExtScript = {}) {
  const calls: ExtCall[] = [];
  const wrap = (m: keyof ExtScript & string, dflt?: Fn) => async (...args: unknown[]) => {
    calls.push({ m, args });
    const f = (script[m as "tabAct"] ?? dflt) as ((...a: unknown[]) => unknown) | undefined;
    if (!f) throw new Error(`ext-мок: ${m} не сценарирован`);
    return f(...args);
  };
  const opt = (m: "tabBatch" | "tabCapture") => (script[m] ? { [m]: wrap(m) } : {}); // старое расширение без метода
  const ext = {
    connected: script.connected ?? true,
    openOrFocus: wrap("openOrFocus"), tabRead: wrap("tabRead"), tabInspect: wrap("tabInspect"), tabAct: wrap("tabAct"),
    tabList: wrap("tabList", () => ({ tabs: [] })), tabClose: wrap("tabClose"), exportCookies: wrap("exportCookies"),
    ...opt("tabBatch"), ...opt("tabCapture"),
  } as unknown as NonNullable<ToolContext["ext"]>;
  return { ext, calls, of: (m: string) => calls.filter((c) => c.m === m) };
}
export type ExtRig = ReturnType<typeof extRig>;

/** Кейс со свежей оснасткой на каждый запуск: `lab` — геттер, предикаты читают оснастку ТЕКУЩЕГО запуска через `rig()`. */
export function rigCase<R>(make: () => R, labOf: (r: R) => Record<string, unknown>, build: (rig: () => R) => ToolCase): ToolCase {
  let cur: R | undefined;
  const c = build(() => (cur ??= make()));
  return Object.defineProperty(c, "lab", { enumerable: true, get: (): Lab => ((cur = make()), labOf(cur) as Lab) });
}

/** Отказ клиента ПК на команды вида `kind` (код `code`); всё прочее делает настоящий FakeDesktop. */
export interface FaultSpec { kind: string; code: string; seed?: DesktopSeed }
const failing = (f: FaultSpec): Fault => (c) => (c.kind === f.kind ? { error: { code: f.code as never, message: `лаборатория: клиент ответил ${f.code}` } } : null);

/** Кейс с моком расширения; `ctx` добавляет части ToolContext (veilDrawing, resolveHost...), `fault` ломает ответы клиента ПК. */
export const extCase = (script: ExtScript, build: (r: () => ExtRig) => ToolCase, ctx: Partial<ToolContext> = {}, fault?: FaultSpec): ToolCase =>
  rigCase(() => extRig(script), (r) => ({ ctx: { ext: r.ext, ...ctx }, ...(fault ? { desktop: faultDesktop(fault.seed ?? {}, failing(fault)) } : {}) }), build);

/** Отказ клиента на команду: null — отдать настоящему FakeDesktop. Всё прочее делает FakeDesktop как обычно. */
export type Fault = (cmd: ActionCommand) => Pick<ActionResult, "error"> & Partial<ActionResult> | null;
export function faultDesktop(seed: DesktopSeed, fault: Fault): FakeDesktop {
  let inner: FakeDesktop | undefined;
  const cur = (): FakeDesktop => (inner ??= createFakeDesktop(seed));
  return {
    handle: async (cmd, meta) => {
      const f = fault(cmd);
      return f ? ({ commandId: meta.commandId, ok: false, durationMs: 0, ...f } as ActionResult) : cur().handle(cmd, meta);
    },
    snapshot: () => cur().snapshot(),
    reset: (s) => cur().reset(s ?? seed),
    advance: (ms) => cur().advance(ms),
    userAction: (k, d) => cur().userAction(k, d),
    onEffect: (cb) => ((inner = createFakeDesktop(seed)), inner.onEffect(cb)),
  };
}
/** Кейс, где клиент ПК отвечает отказом `code` на команды вида `kind`. */
export const clientFails = (seed: DesktopSeed, kind: string, code: string, build: ToolCase): ToolCase =>
  rigCase(() => faultDesktop(seed, failing({ kind, code })), (d) => ({ desktop: d }), () => ({ ...build, seed }));

/** Владелец отвечает `answer`, ТОЛЬКО если в вопросе есть `re`; иначе противоположное — кейс краснеет, если текст вопроса не тот. */
export const asks = (re: RegExp, answer: "yes" | "no" | "expire" | "undelivered"): ConfirmPolicy => (summary) => (re.test(summary) ? answer : answer === "yes" ? "no" : "yes");

/** Открытый интернет лаборатории (seed.web). Скрытый блок и отключённая кнопка — для проверки «видит только видимое». */
export const SHOP_URL = "https://shop.example/";
const SHOP = `<html><head><title>Магазин</title></head><body><main><h1>Каталог</h1><p>Чайник — 1200 ₽</p>
<a href="/cart">Корзина</a><a href="http://localhost:9000/admin">Админка</a><a href="/missing">Битая</a>
<form action="/search" method="get"><input name="q" placeholder="Поиск товаров"><button type="submit">Найти</button></form>
<form action="/pay" method="post"><input name="note" placeholder="Комментарий"><input name="pin" autocomplete="one-time-code" placeholder="Код"><button type="submit">Оплатить заказ</button></form>
<input type="file" name="doc"><button disabled>Недоступно</button><div style="display:none"><button>Скрытая</button></div></main></body></html>`;
export const WEB: Record<string, string> = {
  [SHOP_URL]: SHOP,
  "https://shop.example/cart": "<html><head><title>Корзина</title></head><body><main>Ваша корзина пуста</main></body></html>",
  "https://shop.example/search": "<html><head><title>Результаты</title></head><body><main>Найдено: чайник</main></body></html>",
  "https://shop.example/pay": "<html><head><title>Оплачено</title></head><body><main>Спасибо за заказ</main></body></html>",
  "https://bank.example/account": '<html><head><meta name="lab-requires-cookie" content="sid"><title>Счёт</title></head><body><main>Баланс: 100 ₽</main></body></html>',
  "https://web.telegram.org/k/": '<html><head><title>Telegram</title></head><body><main><form action="/send" method="post"><input name="msg" placeholder="Сообщение"><button type="submit">Отправить</button></form></main></body></html>',
};
export const SEED: DesktopSeed = { web: WEB };

/** Адреса, которые сервер обязан отсечь ДО клиента/расширения: [адрес, чем хитрит]. */
export const SSRF_URLS: Array<[string, string]> = [
  ["http://169.254.169.254/latest/meta-data/", "метаданные облака"],
  ["http://localhost./", "localhost с точкой на конце"],
  ["http://127.1/", "сокращённый loopback 127.1"],
  ["http://0x7f.0.0.1/", "loopback в hex"],
  ["http://2130706433/", "loopback числом"],
  ["http://[::ffff:127.0.0.1]/", "IPv4-mapped IPv6"],
  ["http://shop.example@127.0.0.1/", "userinfo-обман (хост после @)"],
  ["http://100.64.0.1/", "CGNAT-сеть"],
  ["http://printer.local/", "mDNS-имя .local"],
  ["file:///C:/Windows/win.ini", "схема file:"],
  ["chrome://settings", "схема chrome:"],
  ["javascript:alert(1)", "схема javascript:"],
];
/** Имена, что по DNS ведут внутрь (для `lab.dns`): чистое имя, «подмешанный» внутренний адрес (rebinding-стиль), внутренний IPv6. */
export const DNS_INTERNAL = { "intranet.corp.example": ["10.1.2.3"], "mixed.example": ["93.184.216.34", "127.0.0.1"], "v6.example": ["fd00::5"] };

/** Вкладка в списке расширения (tabList). */
export const tabAt = (url: string, extra: Record<string, unknown> = {}) => ({ tabId: 7, url, title: "Вкладка", host: new URL(url).host, active: true, status: "complete", ...extra });
/** Сценарий расширения: `browser_open` даёт вкладку 7 по адресу `url`, список вкладок = она одна; `extra` перекрывает методы. */
export const onTab = (url: string, extra: ExtScript = {}): ExtScript => ({ openOrFocus: () => ({ tabId: 7, focused: false }), tabList: () => ({ tabs: [tabAt(url)] }), ...extra });
/** Предикат по журналу расширения: метод `m` вызван ровно `n` раз (и последний вызов удовлетворяет `check`). */
export const called = (r: () => ExtRig, m: string, n: number, check?: (args: unknown[]) => boolean) => (): boolean | string => {
  const c = r().of(m);
  if (c.length !== n) return `расширение.${m}: ждали ${n} вызов(ов), было ${c.length}`;
  return !check || c.length === 0 || check(c[c.length - 1]!.args) || `расширение.${m}: не те аргументы ${JSON.stringify(c[c.length - 1]!.args)}`;
};
export const ONE_WRAPPER = /<\/untrusted_content>[\s\S]*<\/untrusted_content>/; // второй закрывающий тег = разорванная обёртка

/** Страница оформления заказа в РЕАЛЬНОЙ вкладке и её снимок browser_inspect (e1_3/e1_4 — секретные поля по признаку страницы). */
export const CHECKOUT = "https://shop.example/checkout";
export const FORM = { url: CHECKOUT, title: "Оформление", count: 5, gen: 1, elements: [
  { ref: "e1_1", tag: "input", role: "textbox", name: "Поиск" }, { ref: "e1_2", tag: "button", role: "button", name: "Найти" },
  { ref: "e1_3", tag: "input", role: "textbox", name: "Пароль", secret: true }, { ref: "e1_4", tag: "input", role: "textbox", name: "Поле 2", secret: true },
  { ref: "e1_5", tag: "button", role: "button", name: "Оплатить заказ" },
] };
export const OPEN_INSPECT: Array<{ tool: string; args?: Record<string, unknown> }> = [{ tool: "browser_open", args: { url: CHECKOUT } }, { tool: "browser_inspect" }];

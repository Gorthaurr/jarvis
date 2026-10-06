/**
 * browser_close / browser_sync_login (мок ext + настоящий невидимый браузер над FakeDesktop).
 * browser_close: кого именно закрыли (tabId / хост / активную) и честное «нечего закрывать».
 * browser_sync_login — самый чувствительный: куки залогиненного Chrome (расшифрованные) переезжают в браузер Джарвиса.
 * Факты: что ушло клиенту, значения кук НИГДЕ не видны (ответ модели, журнал эффектов), и после переноса стена входа
 * реально исчезает — а без переноса остаётся.
 */
import type { ToolCase, ToolExpect } from "../case-format.js";
import { SEED, called, extCase, type ExtRig, type ExtScript } from "./web-fixtures.js";

const SECRET = "TOPSECRETVALUE";
const COOKIES = { ok: true, count: 1, cookies: [{ name: "sid", value: SECRET, domain: ".bank.example", path: "/", secure: true }] };
const close = (name: string, script: ExtScript, args: Record<string, unknown>, exp: (r: () => ExtRig) => ToolExpect, tool = "browser_close"): ToolCase =>
  extCase(script, (r) => ({ tool, name, args, expect: { actionKinds: [], asked: 0, ...exp(r) }, coversTool: "browser_close" }));
const sync = (name: string, script: ExtScript, args: Record<string, unknown>, exp: (r: () => ExtRig) => ToolExpect, seed = SEED): ToolCase =>
  extCase(script, (r) => ({ tool: "browser_sync_login", name, args, seed, expect: { asked: 0, ...exp(r) }, coversTool: "browser_sync_login" }));
const leaks = (effects: Array<{ detail: unknown }>): boolean | string => !JSON.stringify(effects).includes(SECRET) || `значение куки «${SECRET}» попало в журнал эффектов ПК`;

export const cases: ToolCase[] = [
  close("по tabId: закрыта ровно эта вкладка, расширению ушёл tabId", { tabClose: () => ({ closed: 1 }) }, { tabId: 7 }, (r) => ({ ok: true, resultIncludes: "Закрыл вкладку.", effects: [called(r, "tabClose", 1, (a) => a[0] === undefined && a[1] === 7)] })),
  close("через фасад browser_tabs{op:close}: то же закрытие по tabId", { tabClose: () => ({ closed: 1 }) }, { op: "close", tabId: 9 }, (r) => ({ ok: true, resultIncludes: "Закрыл вкладку.", effects: [called(r, "tabClose", 1, (a) => a[1] === 9)] }), "browser_tabs"),
  close("по хосту: закрыты ВСЕ вкладки сайта, число названо честно", { tabClose: () => ({ closed: 3 }) }, { url: "youtube.com" }, (r) => ({ ok: true, resultIncludes: "Закрыл 3 вкладки.", effects: [called(r, "tabClose", 1, (a) => a[0] === "youtube.com" && a[1] === undefined)] })),
  close("без аргументов: закрывается активная вкладка (расширению ушло «без адреса и id»)", { tabClose: () => ({ closed: 1 }) }, {}, (r) => ({ ok: true, effects: [called(r, "tabClose", 1, (a) => a[0] === undefined && a[1] === undefined)] })),
  close("закрывать нечего (closed:0): честная ошибка, а не «закрыл»", { tabClose: () => ({ closed: 0 }) }, { tabId: 99 }, () => ({ ok: false, resultIncludes: "Не нашёл такой вкладки", resultExcludes: "Закрыл" })),
  close("расширение упало: «Не смог закрыть вкладку», не «закрыл»", { tabClose: () => { throw new Error("ext_no_reply"); } }, { tabId: 7 }, () => ({ ok: false, resultIncludes: "Не смог закрыть вкладку", resultExcludes: "Закрыл" })),
  close("расширение отключено: закрыть нельзя — ошибка, к расширению не ходили", { connected: false }, { tabId: 7 }, (r) => ({ ok: false, resultIncludes: "не подключено", effects: [called(r, "tabClose", 0)] })),

  sync("перенос логинов: куки ушли клиенту, значение куки нигде не видно (ни модели, ни в журнале ПК)", { exportCookies: () => COOKIES }, {}, () => ({
    ok: true, actionKinds: ["jbrowser.import_cookies"], resultIncludes: "Перенёс логины: 1 из 1", resultExcludes: SECRET,
    effects: [{ has: "jbrowser.import_cookies", detail: { set: 1, total: 1, domains: [".bank.example"] } }, leaks],
  })),
  extCase({ exportCookies: () => COOKIES }, () => ({
    tool: "web_open", name: "после переноса логинов страница за стеной входа открывается по-настоящему (loginWall:false, содержимое видно)", args: { url: "https://bank.example/account" }, seed: SEED,
    before: [{ tool: "browser_sync_login" }], expect: { ok: true, resultIncludes: ['"loginWall":false', "Баланс: 100"] }, coversTool: "browser_sync_login",
  })),
  sync("domains уходят расширению как есть (переносим только названные сайты)", { exportCookies: () => COOKIES }, { domains: ["bank.example"] }, (r) => ({
    ok: true, effects: [called(r, "exportCookies", 1, (a) => JSON.stringify(a[0]) === '["bank.example"]')],
  })),
  sync("часть кук без имени/домена: клиент принял 1 из 2 — так и сказано, не «перенёс всё»", { exportCookies: () => ({ cookies: [...COOKIES.cookies, { name: "", domain: "x.example", value: "v" }] }) }, {}, () => ({
    ok: true, resultIncludes: "Перенёс логины: 1 из 2", resultExcludes: SECRET,
  })),
  sync("кук нет (нет права cookies): ошибка, клиенту ничего не отправлено", { exportCookies: () => ({ cookies: [] }) }, {}, () => ({ ok: false, actionKinds: [], resultIncludes: "куки не получены", resultExcludes: "Перенёс" })),
  sync("расширение не отдало куки (упало): ошибка с подсказкой про разрешения", { exportCookies: () => { throw new Error("ext_no_reply"); } }, {}, () => ({ ok: false, actionKinds: [], resultIncludes: "расширение не отдало куки", resultExcludes: "Перенёс" })),
  sync("расширение отключено: перенос невозможен — ошибка", { connected: false }, {}, (r) => ({ ok: false, actionKinds: [], resultIncludes: "не подключено", effects: [called(r, "exportCookies", 0)] })),
  sync("у клиента нет Chrome: импорт не удался — честная ошибка, «Перенёс» не говорим, значение куки не светим", { exportCookies: () => COOKIES }, {}, () => ({
    ok: false, actionKinds: ["jbrowser.import_cookies"], resultIncludes: "импорт в браузер Джарвиса не удался", resultExcludes: ["Перенёс", SECRET], effects: [{ none: "jbrowser.import_cookies" }],
  }), { ...SEED, installedApps: [] }),
];

/**
 * web_act — руки невидимого браузера Джарвиса: клик/ввод/клавиша/прокрутка/загрузка файла. Факты: что реально сделала
 * страница (эффекты jbrowser.*), цель не найдена = НИЧЕГО не сделано, §0 (пароль/код/карта не вводятся, секрет не
 * эхом), честные исходы при отказах клиента (channelDown / overlayDenied / uncertain). §14 — в web-jb-act14.cases.ts.
 */
import type { CaseStep, ToolCase } from "../case-format.js";
import { SEED as BASE, SHOP_URL, clientFails } from "./web-fixtures.js";

const SEED = { ...BASE, files: { "C:/Users/lab/Documents/cv.pdf": "%PDF-1.4", "C:/Users/lab/.env": "TOKEN=1" } };
const OPEN: CaseStep[] = [{ tool: "web_open", args: { url: SHOP_URL } }];
const act = (name: string, args: Record<string, unknown>, expect: ToolCase["expect"], extra: Partial<ToolCase> = {}): ToolCase =>
  ({ tool: "web_act", name, args, seed: SEED, before: OPEN, expect: { asked: 0, ...expect }, coversTool: "web_act", ...extra });

export const cases: ToolCase[] = [
  act("клик по ссылке (по тексту): страница реально перешла на /cart", { intent: "click", params: { text: "Корзина" } }, {
    ok: true, actionKinds: ["jbrowser.act"], resultIncludes: ["Сделал «click»", '"navigated":"https://shop.example/cart"'],
    effects: [{ has: "jbrowser.click", detail: { label: "Корзина" } }, { has: "jbrowser.navigate", detail: { url: "https://shop.example/cart" } }],
  }),
  act("ввод + Enter в форму поиска: значение прочитано обратно, форма отправлена GET-ом, страница результатов", { intent: "type", params: { selector: 'input[name="q"]', text: "чайник", enter: true } }, {
    ok: true, resultIncludes: ['"value":"чайник"', '"submitted":true'],
    effects: [{ has: "jbrowser.type", detail: { chars: 6 } }, { has: "jbrowser.submit", detail: { method: "get", fields: { q: "чайник" } } }, { has: "jbrowser.navigate", detail: { url: "https://shop.example/search" } }],
  }),
  act("ввод БЕЗ enter: запрос введён, но не запущен (нет submit и перехода)", { intent: "type", params: { selector: 'input[name="q"]', text: "чайник" } }, {
    ok: true, resultIncludes: '"submitted":false', effects: [{ has: "jbrowser.type" }, { none: "jbrowser.submit" }, { none: "jbrowser.navigate" }],
  }),
  act("клавиша Escape в поле: ушла на страницу, вопросов нет (это не коммит)", { intent: "key", params: { key: "Escape", selector: 'input[name="q"]' } }, {
    ok: true, actionKinds: ["jbrowser.act"], effects: [{ has: "jbrowser.key", detail: { combo: "Escape" } }],
  }),
  act("невнятное сочетание клавиш: честный отказ, ничего не нажато", { intent: "key", params: { key: "a+Enter" } }, {
    ok: false, resultIncludes: "не понял клавишу", effects: [{ none: "jbrowser.key" }],
  }),
  act("прокрутка: выполнена без вопросов, эффекта на страницу нет", { intent: "scroll", params: { dy: 400 } }, { ok: true, actionKinds: ["jbrowser.act"], resultIncludes: "Сделал «scroll»" }),
  act("после действия адрес страницы перечитывается перед следующим кликом (гейт судит текущую страницу)", { intent: "click", params: { text: "Корзина" } }, {
    ok: true, actionKinds: ["jbrowser.read", "jbrowser.act"],
  }, { before: [...OPEN, { tool: "web_act", args: { intent: "scroll", params: { dy: 100 } } }] }),
  act("цель не найдена: НИЧЕГО не нажато, в фокус не печатали, ошибка называет причину", { intent: "click", params: { text: "Несуществующая кнопка" } }, {
    ok: false, actionKinds: ["jbrowser.act"], resultIncludes: ["цель на странице не найдена", "НИЧЕГО не делал"], effects: [{ none: "jbrowser.click" }, { none: "jbrowser.type" }],
  }),
  act("отключённая кнопка (disabled): клик не выполнен, это ошибка, не «нажал»", { intent: "click", params: { text: "Недоступно" } }, {
    ok: false, resultIncludes: "не вышло", effects: [{ none: "jbrowser.click" }],
  }),
  act("ссылка во внутреннюю сеть: клик был, переход сорван — «ЗАБЛОКИРОВАН», страница прежняя", { intent: "click", params: { text: "Админка" } }, {
    ok: true, resultIncludes: "Переход на внутренний адрес ЗАБЛОКИРОВАН", effects: [{ has: "jbrowser.click" }, { none: "jbrowser.navigate" }],
  }),
  act("ссылка на недоступную страницу: клик ушёл, исхода нет — «неизвестно» (uncertain), не «не вышло»", { intent: "click", params: { text: "Битая" } }, {
    ok: false, flags: { uncertain: true }, resultIncludes: "ИСХОД НЕИЗВЕСТЕН", effects: [{ has: "jbrowser.click" }],
  }),
  act("интент вне списка (hover): отказ на сервере, клиенту ничего не ушло", { intent: "hover", params: {} }, { ok: false, actionKinds: [], resultIncludes: "не поддержан" }),
  act("§0: поле пароля (по имени в селекторе) — сервер отказывает ДО клиента, секрет не эхом", { intent: "type", params: { selector: 'input[name="password"]', text: "hunter2" } }, {
    ok: false, actionKinds: [], resultIncludes: "Пароли и коды подтверждения не ввожу", resultExcludes: "hunter2",
  }, { before: [{ tool: "web_open", args: { url: "https://bank.example/account" } }] }),
  act("§0: поле кода с немым селектором — отказывает сама страница (secret_field), значение не записано", { intent: "type", params: { selector: 'input[name="pin"]', text: "1234" } }, {
    ok: false, actionKinds: ["jbrowser.act"], resultIncludes: ["Пароли и коды подтверждения не ввожу"], resultExcludes: "1234", effects: [{ none: "jbrowser.type" }],
  }),
  act("§0: номер карты (по Луну) не вводится даже в безобидное поле", { intent: "type", params: { selector: 'input[name="note"]', text: "4111 1111 1111 1111" } }, {
    ok: false, actionKinds: [], resultIncludes: "платёжные реквизиты", resultExcludes: "4111",
  }),
  act("загрузка файла с диска в input[type=file]: эффект upload с путём и размером", { intent: "upload", params: { path: "C:/Users/lab/Documents/cv.pdf" } }, {
    ok: true, actionKinds: ["jbrowser.act"], effects: [{ has: "jbrowser.upload", detail: { path: "C:/Users/lab/Documents/cv.pdf", selector: "input[type=file]", bytes: 8 } }],
  }),
  act("загрузка секретного файла (.env): отказ, файл не «выложен»", { intent: "upload", params: { path: "C:/Users/lab/.env" } }, {
    ok: false, resultIncludes: "защита секретов", effects: [{ none: "jbrowser.upload" }],
  }),
  act("загрузка несуществующего файла: отказ, а не «загрузил»", { intent: "upload", params: { path: "C:/Users/lab/Documents/нет.pdf" } }, {
    ok: false, resultIncludes: "нет или это не файл", effects: [{ none: "jbrowser.upload" }],
  }),
  act("страница не открыта: действие невозможно — ошибка", { intent: "click", params: { text: "Корзина" } }, { ok: false, resultIncludes: "не вышло" }, { before: [] }),
  act("на «ПК» нет Chrome: невидимого браузера нет — ошибка", { intent: "scroll", params: { dy: 10 } }, { ok: false, actionKinds: ["jbrowser.act"], resultIncludes: "не вышло" }, { before: [], seed: { ...SEED, installedApps: [] } }),
  clientFails(SEED, "jbrowser.act", "channel_down", act("канал с ПК мёртв: действие не отправлено, это не провал модели (channelDown)", { intent: "click", params: { text: "Корзина" } }, {
    ok: false, flags: { channelDown: true }, resultIncludes: "канал с ПК временно недоступен", effects: [{ none: "jbrowser.click" }],
  })),
  clientFails(SEED, "jbrowser.act", "overlay_drawing", act("поверх экрана вуаль выделения: действие не выполнено (overlayDenied), не «сделал»", { intent: "click", params: { text: "Корзина" } }, {
    ok: false, flags: { overlayDenied: true }, effects: [{ none: "jbrowser.click" }],
  })),
];

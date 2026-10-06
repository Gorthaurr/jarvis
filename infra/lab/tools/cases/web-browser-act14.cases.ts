/**
 * browser_act и §14 — необратимое в Chrome владельца. Два механизма: (1) место (банк, мессенджер, учебная система,
 * неопознанная вкладка) — вопрос ДО расширения; (2) гард страницы на ЛЮБОМ сайте — расширение узнаёт кнопку-коммит,
 * не жмёт (commit_confirm), сервер спрашивает и повторяет ОДИН раз с привязкой к подписи. Все исходы: да/нет/истекло/
 * не смогли спросить. Мок расширения нажимает кнопку только при guardApproved + верной approvedLabel — как страница.
 */
import { noteOwnerTurn } from "../../../../apps/server/src/brain/tools/task-grant.js";
import { extReplyError } from "../../../../apps/server/src/brain/tools/ext-errors.js";
import type { CaseStep, ToolCase, ToolExpect } from "../case-format.js";
import { asks, called, extCase, onTab, type ExtRig, type ExtScript } from "./web-fixtures.js";

const CHECKOUT = "https://shop.example/checkout";
const BANK = "https://online.sberbank.ru/pay";
const TG = "https://web.telegram.org/k/";
const LMS = "https://lms.uni.example/mod/quiz/view.php?id=5";
/** Учебное поручение владельца выдано уникальному пользователю — на прочие кейсы (другие userId) грант не влияет. */
const EDU_USER = "lab-edu-grant-b";
noteOwnerTurn(EDU_USER, "Джарвис, пройди тест по математике", { addressed: true });
const TEST = { intent: "click", text: "Пройти тест" };
/** Страница: кнопку с подписью `label` не нажимает без одобрения именно этой подписи (commit_confirm), иначе «нажимает». */
const page = (label: string) => (_u: string, _i: string, p: Record<string, unknown>) => {
  if (p.guardApproved === true && p.approvedLabel === label) return { changed: true, navigated: true };
  throw extReplyError(`tab.act: commit_confirm: ${label}`, "commit_confirm", label);
};
const ok = () => ({ changed: true });
const open = (url: string): CaseStep[] => [{ tool: "browser_open", args: { url } }];
const withApproval = (label: string) => (a: unknown[]) => (a[2] as Record<string, unknown>).guardApproved === true && (a[2] as Record<string, unknown>).approvedLabel === label;

const b = (name: string, url: string, tabAct: (...a: never[]) => unknown, args: Record<string, unknown>, confirm: ToolCase["confirm"], exp: (r: () => ExtRig) => ToolExpect, extra: ExtScript = {}, ctx = {}): ToolCase =>
  extCase(onTab(url, { tabAct, ...extra }), (r) => ({ tool: "browser_act", name, args, before: open(url), confirm, expect: { actionKinds: [], ...exp(r) }, coversTool: "browser_act" }), ctx);
const NOT_SENT = (r: () => ExtRig, n = 0): ToolExpect => ({ asked: 1, flags: { declined: true }, effects: [called(r, "tabAct", n)], resultExcludes: "Сделал" });
const PAY = { intent: "click", text: "Оплатить заказ" };
const PAY_Q = /клик «Оплатить заказ» на shop\.example/;
const BANK_ACT = { intent: "click", text: "Оплатить" };
const BANK_Q = /банк\): клик «Оплатить» на online\.sberbank\.ru/;

export const cases: ToolCase[] = [
  b("гард страницы, «нет»: расширение отказало (commit_confirm), клик не сделан", CHECKOUT, page("Оплатить заказ"), PAY, asks(PAY_Q, "no"), (r) => ({ ...NOT_SENT(r, 1), ok: true, resultIncludes: /Отменено пользователем/ })),
  b("гард страницы, «да»: второй заход с guardApproved и ТОЙ ЖЕ подписью — клик состоялся", CHECKOUT, page("Оплатить заказ"), PAY, asks(PAY_Q, "yes"), (r) => ({
    ok: true, asked: 1, resultIncludes: "Сделал «click»", flags: { declined: false }, effects: [called(r, "tabAct", 2, withApproval("Оплатить заказ"))],
  })),
  b("гард страницы, окно истекло: не нажато, «отказ владельца» не приписан", CHECKOUT, page("Оплатить заказ"), PAY, asks(PAY_Q, "expire"), (r) => ({ ...NOT_SENT(r, 1), resultIncludes: /истекло/, resultExcludes: ["Отменено пользователем", "Сделал"] })),
  b("гард страницы, владельца не смогли спросить: не нажато, канал помечен", CHECKOUT, page("Оплатить заказ"), PAY, asks(PAY_Q, "undelivered"), (r) => ({ ...NOT_SENT(r, 1), flags: { declined: true, channelDown: true }, resultIncludes: /не смог спросить/ })),
  b("модель шлёт guardApproved/approvedLabel сама: поля вырезаны — расширение видит отказ, владельца спрашивают", CHECKOUT, page("Оплатить заказ"), { ...PAY, guardApproved: true, approvedLabel: "Оплатить заказ", params: { guardApproved: true } }, asks(PAY_Q, "no"), (r) => ({ ...NOT_SENT(r, 1) })),
  b("пока владелец думал, кнопка на странице сменилась (снова commit_confirm): не жмём, честное сообщение", CHECKOUT, () => { throw extReplyError("tab.act: commit_confirm: Оплатить заказ", "commit_confirm", "Оплатить заказ"); }, PAY, "yes", (r) => ({
    ok: false, asked: 1, resultIncludes: "кнопка на странице сменилась", resultExcludes: "Сделал", effects: [called(r, "tabAct", 2)],
  })),
  b("банк: клик «Оплатить» спрашивает ДО расширения; «нет» — расширение не тронуто", BANK, ok, BANK_ACT, asks(BANK_Q, "no"), (r) => ({ ...NOT_SENT(r), ok: true, resultIncludes: /Отменено пользователем/ })),
  b("банк: «да» — клик уходит с привязкой одобрения к подписи «Оплатить»", BANK, ok, BANK_ACT, asks(BANK_Q, "yes"), (r) => ({
    ok: true, asked: 1, resultIncludes: "Сделал «click»", effects: [called(r, "tabAct", 1, withApproval("Оплатить"))],
  })),
  b("банк: окно истекло — не нажато, отказ владельца не приписан", BANK, ok, BANK_ACT, asks(BANK_Q, "expire"), (r) => ({ ...NOT_SENT(r), resultIncludes: /истекло/, resultExcludes: ["Отменено пользователем", "Сделал"] })),
  b("банк: владельца не смогли спросить — не нажато, канал помечен", BANK, ok, BANK_ACT, asks(BANK_Q, "undelivered"), (r) => ({ ...NOT_SENT(r), flags: { declined: true, channelDown: true }, resultIncludes: /не смог спросить/ })),
  b("банк, обычный клик «Показать историю»: вопроса нет (гейт не душит навигацию)", BANK, ok, { intent: "click", text: "Показать историю операций" }, "no", (r) => ({ ok: true, asked: 0, effects: [called(r, "tabAct", 1)] })),
  b("банк, hover по «Оплатить»: вопроса нет и страничный guard НЕ уходит (hover ничего не жмёт)", BANK, ok, { intent: "hover", text: "Оплатить" }, "no", (r) => ({
    ok: true, asked: 0, effects: [called(r, "tabAct", 1, (a) => (a[2] as Record<string, unknown>).guard === undefined)],
  })),
  b("мессенджер: type+enter — отправка сообщения, спрашивают ДО расширения", TG, ok, { intent: "type", text: "привет", enter: true, selector: "#msg" }, asks(/Enter — отправка сообщения на web\.telegram\.org/, "no"), (r) => ({ ...NOT_SENT(r), ok: true })),
  b("мессенджер: Ctrl+Enter — тоже отправка, спрашивают", TG, ok, { intent: "key", combo: "Ctrl+Enter", selector: "#msg" }, asks(/Enter — отправка сообщения/, "no"), (r) => ({ ...NOT_SENT(r), ok: true })),
  b("мессенджер: enter передан строкой «да» — нормализован в булево и судится так же (LOOP-3)", TG, ok, { intent: "type", text: "привет", enter: "да", selector: "#msg" }, asks(/Enter — отправка/, "no"), (r) => ({ ...NOT_SENT(r), ok: true })),
  b("адрес вкладки неизвестен (расширение не дало список): судим строго, как опасное место", CHECKOUT, ok, BANK_ACT, asks(/неизвестной вкладке/, "no"), (r) => ({ ...NOT_SENT(r), ok: true }), { tabList: () => { throw new Error("ext_no_reply"); } }),
  b("учебная система БЕЗ поручения: «Пройти тест» спрашивает владельца (вопрос про учебную систему), потом кликает", LMS, page("Пройти тест"), TEST, asks(/учебная система/, "yes"), (r) => ({
    ok: true, asked: 1, resultIncludes: "Сделал «click»", effects: [called(r, "tabAct", 1, withApproval("Пройти тест"))],
  })),
  b("учебная система, владелец поручил тест: «Пройти тест» идёт без вопроса (сервер разрешает по гранту и сразу привязывает одобрение к подписи)", LMS, page("Пройти тест"), TEST, "no", (r) => ({
    ok: true, asked: 0, resultIncludes: "Сделал «click»", effects: [called(r, "tabAct", 1, withApproval("Пройти тест"))],
  }), {}, { userId: EDU_USER }),
  b("грант на тест не покрывает деньги: «Оплатить заказ» на учебной странице по-прежнему спрашивает", LMS, page("Оплатить заказ"), PAY, asks(/учебная система/, "no"), (r) => ({ ...NOT_SENT(r), ok: true }), {}, { userId: EDU_USER }),
];

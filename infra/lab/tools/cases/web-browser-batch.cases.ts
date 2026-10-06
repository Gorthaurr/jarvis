/**
 * browser_batch — берст шагов по ref одним вызовом (мок расширения). Факты: ровно то, что судили гарды, уходит
 * расширению (нормализованный шаг, без служебных полей §14 от модели), один вопрос на весь берст, §0 по каждому шагу
 * (включая обход через params.ref), и закон 1 по ответу расширения: k из n, uncertain последнего шага, стопы.
 */
import { extNoReplyError } from "../../../../apps/server/src/brain/tools/ext-errors.js";
import type { ToolCase, ToolExpect } from "../case-format.js";
import { CHECKOUT, FORM, OPEN_INSPECT, asks, called, extCase, onTab, type ExtRig, type ExtScript } from "./web-fixtures.js";

const BANK = "https://online.sberbank.ru/pay";
type Step = Record<string, unknown>;
const SET = { ref: "e1_1", intent: "set", params: { value: "чайник" } };
const CLICK = { ref: "e1_2", intent: "click" };
const PAY = { ref: "e1_5", intent: "click", params: { text: "Оплатить заказ" } };
const DONE = (n: number) => ({ ok: true, done: n, total: n, results: Array.from({ length: n }, (_, i) => ({ step: i, ok: true })) });
const SECRET_REFUSAL = "Пароли и коды подтверждения не ввожу";
const steps = (r: () => ExtRig): Step[] => ((r().of("tabBatch").at(-1)?.args[1] ?? []) as Step[]);
const noBatch = (r: () => ExtRig) => called(r, "tabBatch", 0);

const bb = (name: string, tabBatch: ((...a: never[]) => unknown) | undefined, args: Record<string, unknown>, exp: (r: () => ExtRig) => ToolExpect, opts: { url?: string; confirm?: ToolCase["confirm"]; open?: boolean } = {}): ToolCase => {
  const url = opts.url ?? CHECKOUT;
  const script: ExtScript = onTab(url, { tabInspect: () => ({ ...FORM, url }), ...(tabBatch ? { tabBatch } : {}) });
  return extCase(script, (r) => ({
    tool: "browser_batch", name, args, before: opts.open === false ? [] : OPEN_INSPECT.map((s) => (s.tool === "browser_open" ? { ...s, args: { url } } : s)),
    ...(opts.confirm ? { confirm: opts.confirm } : {}), expect: { actionKinds: [], ...exp(r) }, coversTool: "browser_batch",
  }));
};
export const cases: ToolCase[] = [
  bb("успех: расширению ушли нормализованные шаги в той же вкладке (7), к каждому приложен серверный guard; «Сверь ИСХОД»", () => DONE(2), { steps: [SET, CLICK] }, (r) => ({
    ok: true, asked: 0, flags: { observed: false }, resultIncludes: ["Берст выполнен: 2 из 2 шагов по ref", "Сверь ИСХОД"],
    effects: [called(r, "tabBatch", 1, (a) => a[2] === 7 && Array.isArray(a[1]) && a[1].length === 2), () => (steps(r)[0] as { params?: { value?: string; guard?: unknown } })?.params?.value === "чайник" && typeof (steps(r)[0] as { params?: { guard?: unknown } }).params?.guard === "string" || "шаг 1 ушёл не в той форме"],
  })),
  bb("поля гарда от модели (guardApproved/approvedLabel) вырезаны из шага — самоодобрения нет", () => DONE(1), { steps: [{ ...PAY, params: { text: "Оплатить заказ", guardApproved: true, approvedLabel: "Оплатить заказ" } }] }, (r) => ({
    ok: true, effects: [() => { const p = (steps(r)[0] as { params?: Step })?.params ?? {}; return (p.guardApproved === undefined && p.approvedLabel === undefined) || `в шаге остались служебные поля: ${JSON.stringify(p)}`; }],
  })),
  bb("старая форма шага (action вместо intent): расширению уходит нормализованный intent, action убран", () => DONE(1), { steps: [{ ref: "e1_1", action: "set", params: { value: "x" } }] }, (r) => ({
    ok: true, effects: [() => { const s = steps(r)[0] as Step; return (s?.intent === "set" && s.action === undefined) || `шаг: ${JSON.stringify(s)}`; }],
  })),
  bb("банк, шаг «Оплатить заказ»: ОДИН вопрос на весь берст с перечнем; «нет» — берст не отправлен", () => DONE(2), { steps: [SET, PAY] }, (r) => ({
    ok: true, asked: 1, flags: { declined: true }, resultIncludes: /Отменено пользователем/, resultExcludes: "Берст выполнен", effects: [noBatch(r)],
  }), { url: BANK, confirm: asks(/Необратимые шаги берста на online\.sberbank\.ru: 2: клик «Оплатить заказ»/, "no") }),
  bb("банк: «да» — берст ушёл целиком, у шага-коммита одобрение привязано к подписи", () => DONE(2), { steps: [SET, PAY] }, (r) => ({
    ok: true, asked: 1, resultIncludes: "Берст выполнен: 2 из 2", effects: [() => { const p = (steps(r)[1] as { params?: Step })?.params ?? {}; return (p.guardApproved === true && p.approvedLabel === "Оплатить заказ") || `шаг-коммит: ${JSON.stringify(p)}`; }],
  }), { url: BANK, confirm: asks(/берста/, "yes") }),
  bb("банк: окно подтверждения истекло — берст не отправлен, отказ владельца не приписан", () => DONE(2), { steps: [SET, PAY] }, (r) => ({
    ok: true, asked: 1, flags: { declined: true }, resultIncludes: /истекло/, resultExcludes: ["Отменено пользователем", "Берст выполнен"], effects: [noBatch(r)],
  }), { url: BANK, confirm: "expire" }),
  bb("банк: владельца не смогли спросить — не отправлен, канал помечен", () => DONE(2), { steps: [SET, PAY] }, (r) => ({
    ok: true, asked: 1, flags: { declined: true, channelDown: true }, resultIncludes: /не смог спросить/, effects: [noBatch(r)],
  }), { url: BANK, confirm: "undelivered" }),
  bb("§0: шаг вводит в поле пароля (secret по снимку) — весь берст отвергнут ДО расширения, секрет не эхом", () => DONE(2), { steps: [SET, { ref: "e1_3", intent: "set", params: { value: "hunter2" } }] }, (r) => ({
    ok: false, resultIncludes: SECRET_REFUSAL, resultExcludes: "hunter2", effects: [noBatch(r)],
  })),
  bb("§0: подмена ref через params (верх — безобидный, в params — поле пароля): судится тот ref, что уйдёт", () => DONE(1), { steps: [{ ref: "e1_1", intent: "type", params: { ref: "e1_3", text: "hunter2" } }] }, (r) => ({
    ok: false, resultIncludes: SECRET_REFUSAL, resultExcludes: "hunter2", effects: [noBatch(r)],
  })),
  bb("§0: номер карты в шаге — красная линия, берст не отправлен", () => DONE(1), { steps: [{ ref: "e1_1", intent: "type", params: { text: "4111 1111 1111 1111" } }] }, (r) => ({
    ok: false, resultIncludes: "платёжные реквизиты", resultExcludes: "4111", effects: [noBatch(r)],
  })),
  bb("последний шаг увёл страницу посреди действия: исход НЕИЗВЕСТЕН — uncertain, а не «выполнен»", () => ({ ok: true, done: 2, total: 2, results: [{ ok: true }, { ok: true, result: { navigated: true, uncertain: true } }] }), { steps: [SET, CLICK] }, () => ({
    ok: false, flags: { uncertain: true }, resultIncludes: "исход последнего шага не подтверждён", resultExcludes: "Берст выполнен",
  })),
  bb("стоп на шаге 2 (ref устарел): честное «1 из 3», без «выполнен»; просят свежий снимок", () => ({ ok: false, done: 1, total: 3, stoppedAt: 1, code: "ref_stale", error: "ref_stale: e1_2" }), { steps: [SET, CLICK, CLICK] }, () => ({
    ok: false, resultIncludes: ["выполнено 1 из 3 (стоп на шаге 2)", "browser_inspect"], resultExcludes: "Берст выполнен",
  })),
  bb("шаг увёл страницу (navigated): шаг 1 выполнен, остальные НЕ делались — так и сказано", () => ({ ok: false, done: 1, total: 3, stoppedAt: 0, code: "navigated" }), { steps: [CLICK, SET, CLICK] }, () => ({
    ok: false, resultIncludes: "шаг 1 выполнен, страница перешла", resultExcludes: "Берст выполнен",
  })),
  bb("расширение упёрлось в кнопку-коммит, которую сервер не узнал: не жали, «сделай отдельным browser_act»", () => ({ ok: false, done: 1, total: 2, stoppedAt: 1, code: "commit_confirm", label: "Купить" }), { steps: [SET, CLICK] }, () => ({
    ok: false, resultIncludes: "Сделай его отдельным browser_act", resultExcludes: ["Купить", "Берст выполнен"],
  })),
  bb("страница отказала печатать в секретное поле на шаге: «вводит владелец»", () => ({ ok: false, done: 0, total: 1, stoppedAt: 0, code: "secret_field" }), { steps: [SET] }, () => ({ ok: false, resultIncludes: SECRET_REFUSAL })),
  bb("расширение не ответило после отправки берста: «НЕ ЗНАЮ, что прошло» + uncertain (повтор = дубль ввода)", () => { throw extNoReplyError("нет ответа за 60с"); }, { steps: [SET, CLICK] }, () => ({
    ok: false, flags: { uncertain: true }, resultIncludes: "НЕ ЗНАЮ, сработало ли", resultExcludes: "не удался",
  })),
  bb("пустой список шагов: ошибка до расширения", () => DONE(0), { steps: [] }, (r) => ({ ok: false, resultIncludes: "пустой список шагов", effects: [noBatch(r)] })),
  bb("у шага нет intent: ничего не делали, называют номер шага", () => DONE(1), { steps: [SET, { ref: "e1_2" }] }, (r) => ({ ok: false, resultIncludes: "у шага 2 нет intent", effects: [noBatch(r)] })),
  bb("старое расширение без tabBatch: берст невозможен — честная ошибка про расширение", undefined, { steps: [SET] }, () => ({ ok: false, resultIncludes: "рук во вкладках владельца нет" })),
  bb("цели нет (browser_open не делали): ошибка «сначала открой страницу»", () => DONE(1), { steps: [SET] }, (r) => ({ ok: false, resultIncludes: "сначала открой страницу", effects: [noBatch(r)] }), { open: false }),
];

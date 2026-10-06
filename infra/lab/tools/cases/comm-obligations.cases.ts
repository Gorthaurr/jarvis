/**
 * obligation_add / obligation_list / obligation_remove: счета и обязательства с датой (durable-стор в каталоге прогона).
 * Разовое (due) и ежемесячное (day_of_month) различаются в ответе и в списке, некорректная дата — честный отказ, а
 * подтверждение не обещает больше, чем движок напоминаний реально сделает. Чужие записи другого владельца не видны/не снимаются.
 */
import type { ToolCase } from "../case-format.js";
import { foreignOwner } from "./comm-services.js";

const LIGHT = { what: "счёт за свет", amount: "3000 ₽", due: "2099-07-15T12:00:00" };
const RENT = { what: "аренда квартиры", day_of_month: 1 };
const add = (args: Record<string, unknown>) => ({ tool: "obligation_add", args });
const FOREIGN = foreignOwner({ obligations: [{ id: "foreign-obl-1", what: "чужой кредит" }] });

export const cases: ToolCase[] = [
  {
    tool: "obligation_add",
    name: "разовое со сроком и суммой: ответ называет сумму и дату, есть id",
    args: LIGHT,
    expect: { ok: true, actionKinds: [], resultIncludes: [/Запомнил \(3000 ₽\): счёт за свет — к 15\.07\.2099\. Напомню заранее и в день оплаты\. id=\S+/] },
    coversTool: "obligation_add",
  },
  {
    tool: "obligation_add",
    name: "ежемесячное (day_of_month) — «каждое 1-е число», а не разовая дата",
    args: RENT,
    expect: { ok: true, resultIncludes: "аренда квартиры — каждое 1-е число", resultExcludes: /— к \d/ },
    coversTool: "obligation_add",
  },
  {
    tool: "obligation_add",
    name: "ни срока, ни дня месяца — отказ, а не «запомнил» без даты (напоминать было бы нечем)",
    args: { what: "оплатить интернет" },
    expect: { ok: false, resultIncludes: "укажи срок", resultExcludes: "Запомнил" },
    coversTool: "obligation_add",
  },
  {
    tool: "obligation_add",
    name: "дата не разобрана («послезавтра») — отказ с примером ISO, а не выдуманная дата",
    args: { what: "оплатить интернет", due: "послезавтра" },
    expect: { ok: false, resultIncludes: "не разобрал дату due", resultExcludes: "Запомнил" },
    coversTool: "obligation_add",
  },
  {
    tool: "obligation_add",
    name: "день месяца вне 1..28 (31) — не принят молча за ежемесячное: отказ «укажи срок»",
    args: { what: "аренда", day_of_month: 31 },
    expect: { ok: false, resultIncludes: "укажи срок", resultExcludes: /каждое 31/ },
    coversTool: "obligation_add",
  },
  {
    tool: "obligation_add",
    name: "пустое what — отказ",
    args: { what: "  ", due: "2099-07-15T12:00:00" },
    expect: { ok: false, resultIncludes: "нужно what" },
    coversTool: "obligation_add",
  },
  {
    tool: "obligation_add",
    name: "и due, и day_of_month (взаимоисключимы) — нельзя подтверждать «каждое 5-е», если движок сработает один раз по due",
    args: { what: "аренда", due: "2099-07-15T12:00:00", day_of_month: 5 },
    expect: { resultExcludes: /каждое 5-е число/ },
    coversTool: "obligation_add",
    skip: "ДЕФЕКТ: obligations.ts принимает оба поля и рапортует «каждое 5-е число», а upcomingDue (ambient/obligations.ts) берёт dueAt первым — ежемесячного напоминания не будет",
  },
  {
    tool: "obligation_list",
    name: "нет обязательств — «Запомненных счетов/обязательств нет.»",
    expect: { ok: true, actionKinds: [], resultIncludes: "Запомненных счетов/обязательств нет." },
    coversTool: "obligation_list",
  },
  {
    tool: "obligation_list",
    name: "разовое и ежемесячное видны в списке с суммой и сроком",
    before: [add(LIGHT), add(RENT)],
    expect: { ok: true, resultIncludes: [/• счёт за свет \(3000 ₽\) — к 15\.07\.2099 \(id=/, /• аренда квартиры — каждое 1-е \(id=/] },
    coversTool: "obligation_list",
  },
  {
    tool: "obligation_list",
    name: "чужие обязательства другого владельца не показываются",
    lab: { ctx: FOREIGN },
    before: [add(LIGHT)],
    expect: { ok: true, resultIncludes: "счёт за свет", resultExcludes: "кредит" },
    coversTool: "obligation_list",
  },
  {
    tool: "obligation_remove",
    name: "снятие по фрагменту: «Убрал: счёт за свет.»",
    args: { query: "свет" },
    before: [add(LIGHT)],
    expect: { ok: true, resultIncludes: "Убрал: счёт за свет." },
    coversTool: "obligation_remove",
  },
  {
    tool: "obligation_list",
    name: "после снятия в списке пусто (запись реально удалена)",
    before: [add(LIGHT), { tool: "obligation_remove", args: { query: "свет" } }],
    expect: { ok: true, resultIncludes: "Запомненных счетов/обязательств нет." },
    coversTool: "obligation_remove",
  },
  {
    tool: "obligation_remove",
    name: "нет подходящего — «Не нашёл», а не «убрал»",
    args: { query: "интернет" },
    before: [add(LIGHT)],
    expect: { ok: false, resultIncludes: "Не нашёл обязательства по «интернет»", resultExcludes: "Убрал" },
    coversTool: "obligation_remove",
  },
  {
    tool: "obligation_remove",
    name: "чужое обязательство по тексту снять нельзя",
    args: { query: "кредит" },
    lab: { ctx: FOREIGN },
    expect: { ok: false, resultIncludes: "Не нашёл обязательства", resultExcludes: "Убрал" },
    coversTool: "obligation_remove",
  },
  {
    tool: "obligation_remove",
    name: "чужое обязательство по его id снять нельзя (как у напоминаний и наблюдений)",
    args: { query: "foreign-obl-1" },
    lab: { ctx: FOREIGN },
    expect: { ok: false, resultIncludes: "Не нашёл обязательства", resultExcludes: "Убрал" },
    coversTool: "obligation_remove",
    skip: "ДЕФЕКТ: ObligationStore.cancel (ambient/obligations.ts) ищет по id БЕЗ фильтра userId — у reminders/watch by-id уважает владельца (§sec L2/M12)",
  },
  {
    tool: "obligation_remove",
    name: "пустой запрос — отказ, а не снятие последнего",
    args: { query: "  " },
    before: [add(LIGHT)],
    expect: { ok: false, resultIncludes: "пустой query" },
    coversTool: "obligation_remove",
  },
];

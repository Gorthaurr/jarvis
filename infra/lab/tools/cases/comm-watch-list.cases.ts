/**
 * watch_list / watch_cancel: настоящий сервис наблюдений. Список показывает то, что реально записано (объект, условие,
 * период, «постоянно»), отмена реально снимает запись, а чужие наблюдения другого владельца не видны и не снимаются.
 */
import type { ToolCase } from "../case-format.js";
import { foreignOwner } from "./comm-services.js";

const BTC = { what: "курс биткоина", condition: "упадёт ниже 60000", every_seconds: 300 };
const RAIN = { what: "погода в Москве", condition: "начнётся дождь", every_seconds: 600, continuous: true };
const watch = (args: Record<string, unknown>) => ({ tool: "watch_create", args });
const FOREIGN = foreignOwner({ watches: [{ id: "foreign-watch-1", what: "чужая цена на квартиру", condition: "упадёт" }] });

export const cases: ToolCase[] = [
  {
    tool: "watch_list",
    name: "наблюдений нет — «Активных наблюдений нет.»",
    expect: { ok: true, actionKinds: [], resultIncludes: "Активных наблюдений нет." },
    coversTool: "watch_list",
  },
  {
    tool: "watch_list",
    name: "поставленные наблюдения видны: объект, условие, период; постоянное помечено",
    before: [watch(BTC), watch(RAIN)],
    expect: { ok: true, resultIncludes: ["«курс биткоина» → уведомлю когда «упадёт ниже 60000» (каждые 300 с, id=", "«погода в Москве» → уведомлю когда «начнётся дождь» (каждые 600 с, постоянно, id="] },
    coversTool: "watch_list",
  },
  {
    tool: "watch_list",
    name: "чужие наблюдения другого владельца не показываются",
    lab: { ctx: FOREIGN },
    before: [watch(BTC)],
    expect: { ok: true, resultIncludes: "курс биткоина", resultExcludes: "квартиру" },
    coversTool: "watch_list",
  },
  {
    tool: "watch_cancel",
    name: "отмена по фрагменту описания: «Снял наблюдение: …»",
    args: { query: "биткоин" },
    before: [watch(BTC)],
    expect: { ok: true, resultIncludes: "Снял наблюдение: «курс биткоина»." },
    coversTool: "watch_cancel",
  },
  {
    tool: "watch_list",
    name: "после отмены наблюдение исчезло из списка (отмена снимает запись, а не только говорит об этом)",
    before: [watch(BTC), { tool: "watch_cancel", args: { query: "биткоин" } }],
    expect: { ok: true, resultIncludes: "Активных наблюдений нет." },
    coversTool: "watch_cancel",
  },
  {
    tool: "watch_cancel",
    name: "нет подходящего — «Не нашёл», а не «снял»; чужое наблюдение остаётся",
    args: { query: "квартиру" },
    lab: { ctx: FOREIGN },
    before: [watch(BTC)],
    expect: { ok: false, resultIncludes: "Не нашёл активного наблюдения по «квартиру»", resultExcludes: "Снял" },
    coversTool: "watch_cancel",
  },
  {
    tool: "watch_cancel",
    name: "чужое наблюдение по его id снять нельзя",
    args: { query: "foreign-watch-1" },
    lab: { ctx: FOREIGN },
    expect: { ok: false, resultIncludes: "Не нашёл активного наблюдения", resultExcludes: "Снял" },
    coversTool: "watch_cancel",
  },
  {
    tool: "watch_cancel",
    name: "пустой запрос — отказ, а не снятие последнего",
    args: { query: "  " },
    before: [watch(BTC)],
    expect: { ok: false, resultIncludes: "пустой query" },
    coversTool: "watch_cancel",
  },
];

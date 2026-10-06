/**
 * list_reminders / cancel_reminder: список и отмена напоминаний на настоящем сервисе. Отмена реально снимает запись,
 * разные дела не схлопываются, а два слота одной серии («9 утра» и «9 вечера») не теряются; чужое не видно и не снимается.
 */
import type { ToolCase } from "../case-format.js";
import { foreignOwner } from "./comm-services.js";

const GYM = { text: "Пора в зал, сэр", delay_seconds: 600 };
const EMPTY = "Активных напоминаний нет.";
const set = (args: Record<string, unknown>) => ({ tool: "set_reminder", args });
/** В списке ровно n пунктов «•». */
const bullets = (n: number): RegExp => new RegExp(String.raw`^(?:(?!•)[\s\S])*(?:•(?:(?!•)[\s\S])*){${n}}$`);

export const cases: ToolCase[] = [
  {
    tool: "list_reminders",
    name: "разные дела не схлопываются: «маме» и «врачу» — два напоминания в списке",
    args: {},
    before: [set({ text: "Позвонить маме, сэр", delay_seconds: 3600 }), set({ text: "Записаться к зубному врачу", delay_seconds: 3700 })],
    expect: { ok: true, resultIncludes: ["Позвонить маме", "зубному врачу"] },
    coversTool: "list_reminders",
  },
  {
    tool: "list_reminders",
    name: "нет напоминаний — «Активных напоминаний нет.»",
    args: {},
    expect: { ok: true, actionKinds: [], resultIncludes: EMPTY },
    coversTool: "list_reminders",
  },
  {
    tool: "list_reminders",
    name: "повтор утром и вечером — ДВЕ серии (вечерняя не потеряна), пересказ того же слота (9:02) — не третья",
    before: [
      set({ text: "Выпить таблетки", at: "2099-06-01T09:00", repeat: "daily" }),
      set({ text: "Выпить таблетки", at: "2099-06-01T21:00", repeat: "daily" }),
      set({ text: "Выпить таблетки", at: "2099-06-01T09:02", repeat: "daily" }),
    ],
    expect: { ok: true, resultIncludes: bullets(2), resultExcludes: bullets(3) },
    coversTool: "list_reminders",
  },
  {
    tool: "list_reminders",
    name: "чужие напоминания другого владельца не показываются",
    args: {},
    lab: { ctx: foreignOwner({ reminders: [{ id: "foreign-rem-1", text: "Чужой визит к стоматологу" }] }) },
    before: [set(GYM)],
    expect: { ok: true, resultIncludes: [bullets(1), "Пора в зал"], resultExcludes: "стоматологу" },
    coversTool: "list_reminders",
  },
  {
    tool: "cancel_reminder",
    name: "отмена по фрагменту текста: «Отменил напоминание: …», а в списке пусто",
    args: { query: "зал" },
    before: [set(GYM)],
    expect: { ok: true, resultIncludes: "Отменил напоминание: «Пора в зал, сэр»." },
    coversTool: "cancel_reminder",
  },
  {
    tool: "list_reminders",
    name: "после отмены в списке пусто (отмена реально снимает запись из стора)",
    args: {},
    before: [set(GYM), { tool: "cancel_reminder", args: { query: "зал" } }],
    expect: { ok: true, resultIncludes: EMPTY },
    coversTool: "cancel_reminder",
  },
  {
    tool: "cancel_reminder",
    name: "нет подходящего — честный отказ «Не нашёл», а не «отменил»",
    args: { query: "рыбалка" },
    before: [set(GYM)],
    expect: { ok: false, resultIncludes: "Не нашёл активного напоминания по «рыбалка»", resultExcludes: "Отменил" },
    coversTool: "cancel_reminder",
  },
  {
    tool: "cancel_reminder",
    name: "чужое напоминание (по id и по тексту) снять нельзя",
    args: { query: "foreign-rem-1" },
    lab: { ctx: foreignOwner({ reminders: [{ id: "foreign-rem-1", text: "Чужой визит к стоматологу" }] }) },
    expect: { ok: false, resultIncludes: "Не нашёл активного напоминания", resultExcludes: "Отменил" },
    coversTool: "cancel_reminder",
  },
  {
    tool: "cancel_reminder",
    name: "пустой запрос — отказ, а не отмена последнего",
    args: { query: "  " },
    before: [set(GYM)],
    expect: { ok: false, resultIncludes: "пустой query" },
    coversTool: "cancel_reminder",
  },
];

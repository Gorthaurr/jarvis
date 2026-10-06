/**
 * set_reminder: настоящий сервис напоминаний (durable-стор в каталоге прогона). Проверяем ФАКТ постановки (срок и ТЕКСТ
 * записи в ответе, ритм виден в списке), честные отказы разбора времени/ритма и дедуп «одно дело — одно напоминание»
 * (ответ цитирует ЗАПИСЬ, а не входящий текст: иначе владельцу подтвердили бы формулировку, которой в сторе нет).
 */
import type { ToolCase } from "../case-format.js";

const GYM = { text: "Пора в зал, сэр", delay_seconds: 600 };
const set = (args: Record<string, unknown>) => ({ tool: "set_reminder", args });

export const cases: ToolCase[] = [
  {
    tool: "set_reminder",
    name: "«через 10 минут»: поставлено, ответ называет срок и ТЕКСТ записи, есть id",
    args: GYM,
    expect: { ok: true, actionKinds: [], resultIncludes: [/Напоминание поставлено \(через 10 мин\): «Пора в зал, сэр»\. id=\S+/] },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "абсолютное время at (2099) принято: срок считается сервером, не моделью",
    args: { text: "Поздравить с юбилеем", at: "2099-01-01T09:00" },
    expect: { ok: true, resultIncludes: /Напоминание поставлено \(через \d{4,} дн\)/ },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "повтор daily: ритм назван в ответе И в списке (серия реально записана)",
    args: { ...GYM, repeat: "daily", delay_seconds: 3600 },
    expect: { ok: true, resultIncludes: "далее каждый день" },
    coversTool: "set_reminder",
  },
  {
    tool: "list_reminders",
    name: "серия с интервалом попала в стор: список показывает ритм «каждые 3 ч»",
    before: [set({ text: "Выпить воды", delay_seconds: 3600, repeat_seconds: 10800 })],
    expect: { ok: true, resultIncludes: /• через 1 ч \(каждые 3 ч\): «Выпить воды»/ },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "нулевой/пустой repeat_seconds при repeat:weekdays — работает «по будням», а не «интервал 0 секунд»",
    args: { text: "Планёрка", delay_seconds: 3600, repeat: "weekdays", repeat_seconds: 0 },
    expect: { ok: true, resultIncludes: "далее по будням" },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "repeat_seconds: null не ломает обычное одноразовое напоминание",
    args: { ...GYM, repeat_seconds: null },
    expect: { ok: true, resultIncludes: "Напоминание поставлено (через 10 мин)", resultExcludes: /далее|каждые/ },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "и delay_seconds, и at — честный отказ «не оба», а не выбор одного молча",
    args: { text: "x", delay_seconds: 60, at: "2099-01-01T09:00" },
    expect: { ok: false, resultIncludes: "либо delay_seconds, либо at — не оба", resultExcludes: /поставлено/ },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "at в прошлом — отказ «уже в прошлом» (не молчаливое немедленное срабатывание)",
    args: { text: "x", at: "2020-01-01T09:00" },
    expect: { ok: false, resultIncludes: "уже в прошлом", resultExcludes: /поставлено/ },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "непонятное время («завтра утром») — отказ с подсказкой формата ISO-8601",
    args: { text: "x", at: "завтра утром" },
    expect: { ok: false, resultIncludes: ["Не понял время", "ISO-8601"] },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "ни срока, ни at — отказ, а не напоминание «через ноль»",
    args: { text: "x" },
    expect: { ok: false, resultIncludes: "Нужно указать delay_seconds" },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "срок дальше года — отказ «не больше года»",
    args: { text: "x", delay_seconds: 400 * 86400 },
    expect: { ok: false, resultIncludes: "не больше года" },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "повтор чаще раза в минуту (30 с) — отказ, спам-будильник не ставится",
    args: { text: "x", delay_seconds: 60, repeat_seconds: 30 },
    expect: { ok: false, resultIncludes: "минимум 60" },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "неизвестный ритм («monthly») — отказ с перечнем допустимых, не тихое одноразовое",
    args: { text: "x", delay_seconds: 60, repeat: "monthly" },
    expect: { ok: false, resultIncludes: "daily | weekdays | weekly" },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "пустой текст — отказ «нечего напоминать»",
    args: { text: "   ", delay_seconds: 60 },
    expect: { ok: false, resultIncludes: "пустой text" },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "то же напоминание дважды — второе НЕ создано, ответ честный «уже запланировано»",
    args: GYM,
    before: [set(GYM)],
    expect: { ok: true, resultIncludes: [/Это уже запланировано/, "Второе напоминание не ставил"], resultExcludes: "Напоминание поставлено" },
    coversTool: "set_reminder",
  },
  {
    tool: "set_reminder",
    name: "то же дело другими словами («не забудьте позвонить маме») — схлопнуто, ответ цитирует СУЩЕСТВУЮЩУЮ запись",
    args: { text: "Сэр, не забудьте позвонить маме", delay_seconds: 5400 },
    before: [set({ text: "Позвонить маме, сэр", delay_seconds: 3600 })],
    expect: { ok: true, resultIncludes: ["Это уже запланировано", "«Позвонить маме, сэр»"], resultExcludes: "не забудьте" },
    coversTool: "set_reminder",
  },
];

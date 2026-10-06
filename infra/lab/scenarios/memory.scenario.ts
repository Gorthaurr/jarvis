/**
 * Сценарии «память и время»: запомнить факт и вспомнить в СЛЕДУЮЩЕМ ходе (та же партиция памяти), поставить напоминание.
 * Напоминание проверяется по durable-стору сервера (reminders.json): срабатывание через 10 минут в лаборатории не ждём.
 */
import * as k from "../eval/kit/index.js";
import { REAL_BUDGET, call } from "../eval/dsl.js";
import type { EvalScenario } from "../eval/types.js";

export const scenarios: EvalScenario[] = [
  {
    id: "remember-recall", title: "Запомнить факт и вспомнить в следующем ходе", goal: "Запомни: у меня аллергия на арахис.",
    tags: ["memory"], covers: ["tool:memory_write", "tool:memory_search"], brain: "real", budget: REAL_BUDGET,
    // Пауза: запись памяти идёт в фоне уже после ответа; второй ход — тот же клиент, значит, та же партиция памяти.
    steps: [{ say: "Напомни, на что у меня аллергия?", pauseMs: 2_000 }],
    check: (c) => k.all(k.answerMentions(c, /арахис/iu, "вспомненный факт"), c.turns.length === 2 ? k.pass("два хода разговора") : k.fail(`ходов ${c.turns.length}`)),
    oracle: [
      { calls: [call("memory_write", { content: "У владельца аллергия на арахис", kind: "semantic" })], answer: "Запомнил." },
      { calls: [call("memory_search", { query: "аллергия" })], answer: "У вас аллергия на арахис." },
    ],
  },
  {
    id: "reminder-in-10-min", title: "Напоминание через десять минут", goal: "Напомни мне через десять минут позвонить маме.",
    tags: ["time", "memory"], covers: ["tool:set_reminder"], brain: "real", budget: REAL_BUDGET,
    // Окно с запасом на длительность прогона (кап задачи 240 с): срок = ~10 мин от момента постановки.
    check: (c) => k.reminderStored(c, { text: /позвонить\s+маме/iu, minSec: 300, maxSec: 640 }),
    oracle: [{ calls: [call("set_reminder", { text: "позвонить маме", delay_seconds: 600 })], answer: "Напомню через десять минут позвонить маме." }],
  },
];

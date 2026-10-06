/**
 * Сценарии «управление ПК»: громкость (tier0 — закрывается без модели), буфер обмена, раскладка окон по мониторам, закрытие
 * программы. Проверка — итоговое состояние: громкость, буфер, окна и их мониторы.
 */
import * as k from "../eval/kit/index.js";
import { FAST_BUDGET, REAL_BUDGET, call } from "../eval/dsl.js";
import type { DesktopSeed } from "../lib/contracts.js";
import type { EvalScenario } from "../eval/types.js";

const chrome = { title: "Новая вкладка - Google Chrome", process: "chrome" };
const word = { title: "Отчёт — Word", process: "WINWORD" };
const tg = { title: "Telegram", process: "Telegram" };
const calc = { title: "Калькулятор", process: "CalculatorApp" };
const notepad = { title: "Безымянный — Блокнот", process: "notepad" };

const loud = (volume: number): DesktopSeed => ({ volume });
const volume = (id: string, title: string, goal: string, vol: number, check: EvalScenario["check"], answer: string, op: Record<string, unknown>): EvalScenario => ({
  id, title, goal, tags: ["system", "tier0"], covers: ["tool:system_volume", "action:system.volume", "intent:volume"], brain: "either", budget: FAST_BUDGET, seed: loud(vol), check,
  oracle: [{ calls: [call("system_volume", op)], answer }],
});

export const scenarios: EvalScenario[] = [
  volume("volume-quieter", "Сделать потише", "Сделай потише.", 60, k.volumeLowered, "Убавил.", { op: "down" }),
  volume("volume-louder", "Сделать погромче", "Сделай погромче.", 30, k.volumeRaised, "Прибавил.", { op: "up" }),
  volume("mute", "Выключить звук", "Выключи звук.", 40, k.soundOff, "Заглушил.", { op: "mute" }),
  {
    id: "clipboard-copy", title: "Положить текст в буфер обмена", goal: "Положи в буфер обмена адрес: улица Ленина, дом 5.",
    tags: ["system"], covers: ["tool:system_clipboard", "action:system.clipboard"], brain: "real", budget: REAL_BUDGET,
    check: (c) => k.clipboardHas(c, "Ленина", /дом\s*5|д\.\s*5/iu),
    oracle: [{ calls: [call("system_clipboard", { op: "write", text: "улица Ленина, дом 5" })], answer: "Адрес в буфере." }],
  },
  {
    id: "windows-monitors", title: "Раскидать окна по мониторам", goal: "Браузер оставь на основном мониторе, а Ворд и Телеграм перенеси на второй.",
    tags: ["system", "gui"], covers: ["tool:window_arrange", "action:window.arrange"], brain: "real", budget: REAL_BUDGET, seed: { windows: [chrome, word, tg] },
    check: (c) => k.all(k.windowOnMonitor(c, { process: /^chrome$/iu }, 1), k.windowOnMonitor(c, { process: /^winword$/iu }, 2), k.windowOnMonitor(c, { process: /^telegram$/iu }, 2)),
    oracle: [{ calls: [call("window_arrange", { op: "move", query: "Word", monitor: 1 }), call("window_arrange", { op: "move", query: "Telegram", monitor: 1 })], answer: "Ворд и Телеграм на втором мониторе, браузер на основном." }],
  },
  {
    id: "close-program", title: "Закрыть программу", goal: "Закрой калькулятор.",
    tags: ["system", "gui"], covers: ["tool:app_close", "action:app.close"], brain: "real", budget: REAL_BUDGET, seed: { windows: [calc, chrome, notepad] },
    // Закрыт именно калькулятор; браузер и блокнот (пустой, без несохранённого) не тронуты.
    check: (c) => k.all(k.windowGone(c, { process: /^calculatorapp$/iu }), k.windowsUntouched(c, { process: /^calculatorapp$/iu })),
    oracle: [{ calls: [call("app_close", { app: "calc" })], answer: "Калькулятор закрыт." }],
  },
];

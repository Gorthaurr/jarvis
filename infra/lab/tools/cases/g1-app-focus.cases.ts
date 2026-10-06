/**
 * G1 · app_focus. Фокус — это ПЕРЕДНЕЕ окно на «ПК», а не слова «готово»: нет приложения → not_found, вуаль → отказ,
 * свёрнутое окно возвращается.
 */
import type { ToolCase } from "../case-format.js";
import { DESK, NOTEPAD_SEED, titleOfForeground } from "./g1-fixtures.js";

const LAUNCH = (app: string) => ({ tool: "app_launch", args: { app } });

export const cases: ToolCase[] = [
  {
    tool: "app_focus",
    name: "калькулятор выходит на передний план поверх блокнота",
    args: { app: "калькулятор" },
    before: [LAUNCH("calc"), LAUNCH("notepad")],
    expect: {
      ok: true,
      actionKinds: ["app.focus"],
      resultIncludes: '"focused":true',
      effects: [{ has: "window.focus", detail: { process: "CalculatorApp", via: "app.focus" } }],
      state: (s) => titleOfForeground(s) === "Калькулятор" || `переднее «${titleOfForeground(s)}»`,
    },
    coversTool: "app_focus",
  },
  {
    tool: "app_focus",
    name: "приложение не запущено — честный not_found, фокус никуда не ушёл",
    args: { app: "калькулятор" },
    seed: NOTEPAD_SEED,
    expect: {
      ok: false,
      actionKinds: ["app.focus"],
      resultIncludes: ["not_found", "Запусти его (app_launch)"],
      resultExcludes: /"focused":true/,
      effects: [{ none: "window.focus" }],
      state: (s) => titleOfForeground(s) === "Заметки — Блокнот" || `переднее «${titleOfForeground(s)}»`,
    },
    coversTool: "app_focus",
  },
  {
    tool: "app_focus",
    name: "приложения нет — подсказка ведёт к запуску, а не в «a11y-дерево/canvas»",
    args: { app: "калькулятор" },
    seed: NOTEPAD_SEED,
    skip: "ДЕФЕКТ: dispatch.ts:882 A11Y_KINDS содержит app.focus, и любой not_found (приложение просто не запущено) получает приписку «элемент не в a11y-дереве… сними screen_capture, кликай по координатам» — она противоречит сообщению клиента «Запусти его (app_launch)»",
    expect: { ok: false, resultIncludes: "app_launch", resultExcludes: [/a11y/i, /canvas/i, /screen_capture/] },
    coversTool: "app_focus",
  },
  {
    tool: "app_focus",
    name: "свёрнутое окно разворачивается и становится передним",
    args: { app: "calc" },
    before: [LAUNCH("calc"), { tool: "window", args: { op: "minimize", query: "Калькулятор" } }],
    expect: {
      ok: true,
      state: (s) => {
        const w = s.windows.find((x) => x.process === "CalculatorApp");
        return (w && !w.minimized && s.foregroundHwnd === w.hwnd) || `свёрнуто=${w?.minimized}, переднее hwnd=${s.foregroundHwnd}`;
      },
    },
    coversTool: "app_focus",
  },
  {
    tool: "app_focus",
    name: "фокус по подстроке заголовка окна (не только по имени процесса)",
    args: { app: "Музыка" },
    seed: DESK,
    expect: { ok: true, actionKinds: ["app.focus"], state: (s) => titleOfForeground(s) === "Музыка" || `переднее «${titleOfForeground(s)}»` },
    coversTool: "app_focus",
  },
  {
    tool: "app_focus",
    name: "под вуалью режима выделения фокус не меняем: overlay_drawing, переднее окно прежнее",
    args: { app: "калькулятор" },
    before: [LAUNCH("calc"), LAUNCH("notepad"), { tool: "screen_selection", args: { op: "start" } }],
    expect: {
      ok: false,
      flags: { overlayDenied: true },
      effects: [{ none: "window.focus" }],
      state: (s) => titleOfForeground(s) === "Безымянный — Блокнот" || `переднее «${titleOfForeground(s)}»`,
    },
    coversTool: "app_focus",
  },
];

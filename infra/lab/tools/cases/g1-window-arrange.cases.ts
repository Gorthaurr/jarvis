/**
 * G1 · window_arrange (свернуть/развернуть/восстановить/перенести). Проверяем итоговый rect и монитор окна на «ПК»,
 * а не «готово»; неверная цель/монитор/аргументы — ошибка и окно не тронуто; вуаль выделения не даёт переставлять.
 */
import type { ToolCase } from "../case-format.js";
import { DESK } from "./g1-fixtures.js";

const WORD = { x: 100, y: 100, w: 1200, h: 800 }; // rect окна из seed по умолчанию
const winByTitle = (s: { windows: Array<{ hwnd: number; title: string; rect: typeof WORD; monitor: number; minimized: boolean }> }, t: string) => s.windows.find((w) => w.title === t);
const rectIs = (title: string, r: typeof WORD): NonNullable<ToolCase["expect"]["state"]> => (s) => {
  const w = winByTitle(s, title);
  return (w && JSON.stringify(w.rect) === JSON.stringify(r)) || `rect «${title}» = ${JSON.stringify(w?.rect)}, ждали ${JSON.stringify(r)}`;
};
const untouched = (title = "Отчёт — Word (копия)"): NonNullable<ToolCase["expect"]["state"]> => (s) => {
  const w = winByTitle(s, title);
  return (w && !w.minimized && JSON.stringify(w.rect) === JSON.stringify(WORD) && w.monitor === 1) || `окно «${title}» тронуто: ${JSON.stringify(w)}`;
};
const noArrange = { none: "window.move" } as const;

export const cases: ToolCase[] = [
  {
    tool: "window_arrange",
    name: "minimize: окно свёрнуто, монитор «свёрнуто», передним становится другое окно",
    args: { op: "minimize", query: "Чат" },
    seed: DESK,
    expect: {
      ok: true,
      actionKinds: ["window.arrange"],
      resultIncludes: ['"minimized":true', '"monitor":"свёрнуто"', '"monitorIndex":null'],
      effects: [{ has: "window.minimize", detail: { process: "Telegram" } }],
      state: (s) => (winByTitle(s, "Чат — Telegram")?.minimized === true && s.foregroundHwnd !== null && s.foregroundHwnd !== winByTitle(s, "Чат — Telegram")!.hwnd ? true : `foreground=${s.foregroundHwnd}`),
    },
    coversTool: "window_arrange",
  },
  {
    tool: "window_arrange",
    name: "maximize: окно занимает рабочую область основного монитора (без панели задач)",
    args: { op: "maximize", query: "копия" },
    seed: DESK,
    expect: { ok: true, resultIncludes: '"maximized":true', effects: [{ has: "window.maximize" }], state: rectIs("Отчёт — Word (копия)", { x: 0, y: 0, w: 2560, h: 1400 }) },
    coversTool: "window_arrange",
  },
  {
    tool: "window_arrange",
    name: "restore после maximize возвращает прежний размер и позицию",
    args: { op: "restore", query: "копия" },
    seed: DESK,
    before: [{ tool: "window_arrange", args: { op: "maximize", query: "копия" } }],
    expect: { ok: true, resultIncludes: '"maximized":false', state: rectIs("Отчёт — Word (копия)", WORD) },
    coversTool: "window_arrange",
  },
  {
    tool: "window_arrange",
    name: "move на второй монитор: размер сохранён, окно по центру рабочей области, ответ — перечитанное состояние",
    args: { op: "move", query: "копия", monitor: 1 },
    seed: DESK,
    expect: {
      ok: true,
      resultIncludes: ['"monitorIndex":1', '"monitor":"монитор 2"', '"rect":{"x":2920,"y":140,"w":1200,"h":800}'],
      effects: [{ has: "window.move", detail: { monitor: 1 } }],
      state: (s) => (winByTitle(s, "Отчёт — Word (копия)")?.monitor === 2 ? rectIs("Отчёт — Word (копия)", { x: 2920, y: 140, w: 1200, h: 800 })(s) : "монитор окна не сменился"),
    },
    coversTool: "window_arrange",
  },
  {
    tool: "window_arrange",
    name: "move + maximizeAfterMove: окно растянуто на весь второй монитор",
    args: { op: "move", query: "копия", monitor: 1, maximizeAfterMove: true },
    seed: DESK,
    expect: { ok: true, resultIncludes: '"maximized":true', state: rectIs("Отчёт — Word (копия)", { x: 2560, y: 0, w: 1920, h: 1080 }) },
    coversTool: "window_arrange",
  },
  {
    tool: "window_arrange",
    name: "move без monitor — ошибка, окно на прежнем месте (а не «перенёс куда-нибудь»)",
    args: { op: "move", query: "копия" },
    seed: DESK,
    expect: { ok: false, resultIncludes: /нужен индекс монитора/, effects: [noArrange], state: untouched() },
    coversTool: "window_arrange",
  },
  {
    tool: "window_arrange",
    name: "move на несуществующий монитор 7 — ошибка с числом мониторов, окно не двинулось",
    args: { op: "move", query: "копия", monitor: 7 },
    seed: DESK,
    expect: { ok: false, resultIncludes: /монитора с индексом 7 нет \(всего 2\)/, effects: [noArrange], state: untouched() },
    coversTool: "window_arrange",
  },
  {
    tool: "window_arrange",
    name: "окна с таким заголовком нет — ошибка, ни одно окно не тронуто",
    args: { op: "minimize", query: "Photoshop" },
    seed: DESK,
    expect: { ok: false, resultIncludes: /не найдено среди открытых/, effects: [{ none: "window.minimize" }], state: (s) => s.windows.filter((w) => w.minimized).length === 1 || "свернулось лишнее окно" },
    coversTool: "window_arrange",
  },
  {
    tool: "window_arrange",
    name: "устаревший hwnd закрытого окна — ошибка «перечитай window_list», не тихий успех",
    args: { op: "minimize", hwnd: 1002 },
    seed: DESK,
    before: [{ tool: "app_close", args: { app: "winword" } }],
    expect: { ok: false, resultIncludes: /окна с hwnd 1002 нет/, effects: [{ none: "window.minimize" }] },
    coversTool: "window_arrange",
  },
  {
    tool: "window_arrange",
    name: "тёзки: двигается ТОЛЬКО верхнее окно по подстроке, второе Word не тронуто",
    args: { op: "move", query: "Word", monitor: 1 },
    seed: DESK,
    expect: { ok: true, state: (s) => (winByTitle(s, "Отчёт — Word (копия)")?.monitor === 2 ? untouched("Отчёт — Word")(s) : "верхнее окно не переехало") },
    coversTool: "window_arrange",
  },
  {
    tool: "window_arrange",
    name: "maximize под вуалью режима выделения запрещён: overlay_drawing, размер прежний",
    args: { op: "maximize", query: "копия" },
    seed: DESK,
    before: [{ tool: "screen_selection", args: { op: "start" } }],
    expect: { ok: false, flags: { overlayDenied: true }, effects: [{ none: "window.maximize" }], state: untouched() },
    coversTool: "window_arrange",
  },
  {
    tool: "window",
    name: "window{op:maximize} через фасад = window_arrange: тот же итоговый rect",
    args: { op: "maximize", query: "копия" },
    seed: DESK,
    expect: { ok: true, actionKinds: ["window.arrange"], state: rectIs("Отчёт — Word (копия)", { x: 0, y: 0, w: 2560, h: 1400 }) },
    coversTool: "window_arrange",
  },
  {
    tool: "window_arrange",
    name: "неизвестная операция не должна рапортоваться выполненной (настоящий клиент без ветки else вернёт ok без действия)",
    args: { op: "explode", query: "копия", monitor: 1 },
    seed: DESK,
    skip: "пробел лаборатории: FakeDesktop window.arrange трактует любой неизвестный op как move (окно переезжает); настоящий arrangeWindow (window-arrange.ts, PS без else) не сделает ничего и вернёт ok — живьём не проверено",
    expect: { ok: false, effects: [noArrange], state: untouched() },
    coversTool: "window_arrange",
  },
];

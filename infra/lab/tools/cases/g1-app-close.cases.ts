/**
 * G1 · app_close. Graceful не обходит вопрос «Сохранить?» и НЕ рапортует «закрыл», пока окно живо; force=true — только
 * после «да» владельца (все исходы §14 — разные тексты); критические процессы и wildcard клиент не трогает.
 */
import type { ToolCase } from "../case-format.js";
import { DESK, titleOfForeground } from "./g1-fixtures.js";

const UNSAVED = [{ tool: "app_launch", args: { app: "notepad" } }, { tool: "input_type", args: { text: "несохранённая мысль" } }];
const UNSAVED_TITLE = "*Безымянный — Блокнот";
const intact = (s: { windows: Array<{ title: string }> }): boolean | string => s.windows.some((w) => w.title === UNSAVED_TITLE) || `окно с несохранённым пропало: ${JSON.stringify(s.windows.map((w) => w.title))}`;

const forceCase = (name: string, confirm: ToolCase["confirm"], expect: ToolCase["expect"]): ToolCase => ({
  tool: "app_close",
  name,
  args: { app: "notepad", force: true },
  before: UNSAVED,
  confirm,
  expect: { asked: 1, ...expect },
  coversTool: "app_close",
});

export const cases: ToolCase[] = [
  {
    tool: "app_close",
    name: "graceful: чистый калькулятор закрыт, вопросов нет",
    args: { app: "calc" },
    before: [{ tool: "app_launch", args: { app: "calc" } }],
    expect: {
      ok: true,
      asked: 0,
      resultIncludes: '"closed":1',
      effects: [{ has: "window.close", detail: { process: "CalculatorApp", force: false } }],
      state: (s) => s.windows.length === 0 || "окно осталось",
    },
    coversTool: "app_close",
  },
  {
    tool: "app_close",
    name: "graceful с несохранённым: приложение спросило «Сохранить?» — НЕ «закрыл», окно и текст на месте",
    args: { app: "блокнот" },
    before: UNSAVED,
    expect: {
      ok: false,
      asked: 0,
      resultIncludes: ["not_found", "не закрыл"],
      resultExcludes: /"closed":[1-9]/,
      effects: [{ has: "window.close.blocked" }, { has: "app.close", detail: { closed: 0 } }],
      state: (s) => intact(s) === true && s.windows.some((w) => w.title === "Блокнот") ? true : `${intact(s)}; диалога «Сохранить?» нет`,
    },
    coversTool: "app_close",
  },
  // Политика-функция видит текст вопроса: «да» только на настоящий §14-вопрос про принудительное закрытие блокнота (kind irreversible)
  forceCase("force + «да» на вопрос про принудительное закрытие: закрыто, несохранённое потеряно (вопрос был один)", (summary, kind) => (kind === "irreversible" && /Закрыть «notepad» принудительно\? Несохранённое будет потеряно/.test(summary) ? "yes" : "no"), {
    ok: true,
    actionKinds: ["app.close"],
    resultIncludes: '"closed":1',
    effects: [{ has: "window.close", detail: { force: true } }],
    state: (s) => s.windows.length === 0 || "окно осталось",
  }),
  forceCase("force + «нет»: клиенту ничего не ушло, окно и текст целы", "no", {
    flags: { declined: true },
    actionKinds: [],
    resultIncludes: /Отменено пользователем/,
    state: intact,
  }),
  forceCase("force + окно вопроса истекло: не «нет», а «не ответили» — и не закрыли", "expire", {
    flags: { declined: true },
    actionKinds: [],
    resultIncludes: /не ответили|истекл/,
    resultExcludes: /Отменено пользователем/,
    state: intact,
  }),
  forceCase("force + владельца не смогли спросить: отказ не приписан ему, помечена недоступность канала", "undelivered", {
    flags: { declined: true, channelDown: true },
    actionKinds: [],
    resultIncludes: /не смог спросить/,
    resultExcludes: /Отменено пользователем/,
    state: intact,
  }),
  {
    tool: "app_close",
    name: "force строкой «true» — гейт §14 обязан сработать так же, как на true (клиент читает force по truthiness)",
    args: { app: "notepad", force: "true" },
    before: UNSAVED,
    confirm: "no",
    skip: "ДЕФЕКТ: dispatch.ts:685 гейт §14 — `input.force === true`, а pickBySchema пропускает строку как есть, и настоящий клиент (apps.ts closeApp: `force ? '1' : '0'`) читает её по truthiness → app_close{force:\"true\"} убивает процесс (Stop-Process -Force) БЕЗ вопроса владельцу",
    expect: { asked: 1, flags: { declined: true }, actionKinds: [], state: intact },
    coversTool: "app_close",
  },
  {
    tool: "app_close",
    name: "explorer (критический процесс) закрыть нельзя — отказ клиента, окно на месте",
    args: { app: "explorer" },
    seed: { windows: [{ title: "Проводник", process: "explorer" }] },
    expect: { ok: false, actionKinds: ["app.close"], resultIncludes: /критический системный процесс/, effects: [{ none: "window.close" }], state: (s) => s.windows.length === 1 || "проводник закрыт" },
    coversTool: "app_close",
  },
  {
    tool: "app_close",
    name: "сам Джарвис (electron) закрыть нельзя — отказ клиента, окно на месте",
    args: { app: "electron" },
    seed: { windows: [{ title: "Джарвис", process: "electron" }] },
    expect: { ok: false, resultIncludes: /это сам Джарвис/, effects: [{ none: "window.close" }], state: (s) => s.windows.length === 1 || "окно Джарвиса закрыто" },
    coversTool: "app_close",
  },
  {
    tool: "app_close",
    name: "wildcard «*» в имени — отказ, «закрой всё» не сносит чужие процессы",
    args: { app: "*" },
    seed: DESK,
    expect: { ok: false, resultIncludes: /не должно содержать/, effects: [{ none: "window.close" }], state: (s) => s.windows.length === DESK.windows!.length || "окна пропали" },
    coversTool: "app_close",
  },
  {
    tool: "app_close",
    name: "процесс не запущен — честный not_found, а не «закрыл»",
    args: { app: "discord" },
    seed: DESK,
    expect: { ok: false, resultIncludes: ["not_found", "не закрыл"], effects: [{ none: "window.close" }], state: (s) => titleOfForeground(s) === "Чат — Telegram" || "фокус сдвинулся" },
    coversTool: "app_close",
  },
  {
    tool: "app_close",
    name: "два экземпляра блокнота: закрыты оба, closed=2",
    args: { app: "notepad" },
    seed: { windows: [{ title: "a.txt — Блокнот", process: "notepad" }, { title: "b.txt — Блокнот", process: "notepad" }, { title: "Музыка", process: "spotify" }] },
    expect: { ok: true, resultIncludes: '"closed":2', state: (s) => (s.windows.length === 1 && s.windows[0]!.process === "spotify") || `остались ${JSON.stringify(s.windows.map((w) => w.title))}` },
    coversTool: "app_close",
  },
];

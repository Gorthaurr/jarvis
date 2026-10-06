/**
 * G1 · app_launch. «Запущено» = появилось окно/процесс на «ПК»; неизвестное приложение — честный not_found;
 * SSRF-гард срабатывает на сервере, ДО клиента (actionKinds: []).
 */
import type { ToolCase } from "../case-format.js";
import { titleOfForeground } from "./g1-fixtures.js";

const WEB = { "https://example.com/": "<title>Пример</title>Привет" };

const blocked = (name: string, app: string, why: RegExp): ToolCase => ({
  tool: "app_launch",
  name,
  args: { app },
  expect: { ok: false, actionKinds: [], resultIncludes: why, effects: [{ none: "window.open" }], state: (s) => s.windows.length === 0 || "окно всё же открылось" },
  coversTool: "app_launch",
});

export const cases: ToolCase[] = [
  {
    tool: "app_launch",
    name: "«блокнот» по-русски: окно открылось, стало передним, процесс один",
    args: { app: "блокнот" },
    expect: {
      ok: true,
      actionKinds: ["app.launch"],
      resultIncludes: ['"verified":"process"', "Безымянный — Блокнот"],
      effects: [{ has: "window.open", detail: { process: "notepad" } }, { has: "app.launch", detail: { app: "блокнот", reused: false } }],
      state: (s) => (s.processes.notepad === 1 && titleOfForeground(s) === "Безымянный — Блокнот") || `процессы ${JSON.stringify(s.processes)}, переднее «${titleOfForeground(s)}»`,
    },
    coversTool: "app_launch",
  },
  {
    tool: "app_launch",
    name: "программы нет в системе — честный not_found, окна нет и слова «запустил» нет",
    args: { app: "фотошоп" },
    expect: {
      ok: false,
      actionKinds: ["app.launch"],
      resultIncludes: ["not_found", "не найдено или не установлено"],
      resultExcludes: [/"resolved"/, /verified/],
      effects: [{ none: "window.open" }],
      state: (s) => Object.keys(s.processes).length === 0 || `появились процессы ${JSON.stringify(s.processes)}`,
    },
    coversTool: "app_launch",
  },
  {
    tool: "app_launch",
    name: "установленность берётся из системы: steam не установлен → не запущен",
    args: { app: "стим" },
    seed: { installedApps: ["notepad"] },
    expect: { ok: false, actionKinds: ["app.launch"], resultIncludes: "not_found", state: (s) => !("steam" in s.processes) || "steam запустился без установки" },
    coversTool: "app_launch",
  },
  {
    tool: "app_launch",
    name: "одиночное приложение (калькулятор) вторым запуском не плодит окон: вернулись к тому же",
    args: { app: "calc" },
    before: [{ tool: "app_launch", args: { app: "calc" } }],
    expect: {
      ok: true,
      resultIncludes: '"verified":"appid-already"',
      effects: [{ has: "app.launch", detail: { reused: true } }, { none: "window.open" }],
      state: (s) => s.processes.CalculatorApp === 1 || `окон калькулятора: ${s.processes.CalculatorApp}`,
    },
    coversTool: "app_launch",
  },
  {
    tool: "app_launch",
    name: "блокнот многооконный: второй запуск — второе окно, оба живы",
    args: { app: "notepad" },
    before: [{ tool: "app_launch", args: { app: "notepad" } }],
    expect: { ok: true, effects: [{ has: "window.open", count: 1 }], state: (s) => s.processes.notepad === 2 || `окон блокнота: ${s.processes.notepad}` },
    coversTool: "app_launch",
  },
  {
    tool: "app_launch",
    name: "публичный https-адрес открывается в браузере (гард не режет лишнего), страница загрузилась",
    args: { app: "https://example.com/" },
    seed: { web: WEB },
    expect: {
      ok: true,
      actionKinds: ["app.launch"],
      effects: [{ has: "browser.navigate", detail: { url: "https://example.com/", loaded: true } }],
      state: (s) => titleOfForeground(s) === "Пример - Google Chrome" || `переднее «${titleOfForeground(s)}»`,
    },
    coversTool: "app_launch",
  },
  {
    tool: "app_launch",
    name: "путь к текстовому файлу: открывается в блокноте с его содержимым, заголовок = имя файла",
    args: { app: "C:/Users/lab/Documents/notes.txt" },
    seed: { files: { "Documents/notes.txt": "купить хлеб" } },
    expect: {
      ok: true,
      actionKinds: ["app.launch"],
      effects: [{ has: "window.open", detail: { process: "notepad" } }],
      state: (s) => (s.windows.some((w) => w.title === "notes.txt — Блокнот" && w.text === "купить хлеб") ? true : `окна: ${JSON.stringify(s.windows.map((w) => [w.title, w.text]))}`),
    },
    coversTool: "app_launch",
  },
  {
    tool: "app_launch",
    name: "путь к несуществующему файлу — честный not_found, блокнот не открыт «впустую»",
    args: { app: "C:/Users/lab/Documents/нет-такого.txt" },
    expect: { ok: false, resultIncludes: /not_found.*такого файла или каталога нет/, effects: [{ none: "window.open" }], state: (s) => s.windows.length === 0 || "появилось окно" },
    coversTool: "app_launch",
  },
  blocked("адрес метаданных облака — SSRF по имени, до клиента не доходит", "http://169.254.169.254/latest/meta-data/", /заблокирован/),
  blocked("loopback с портом сервера Джарвиса — отказ до клиента", "http://127.0.0.1:8787/dev/say", /заблокирован/),
  blocked("имя, что разрешается во внутреннюю сеть (localtest.me) — суд по DNS, регистр схемы не спасает", "HTTPS://localtest.me/admin", /SSRF|внутрен/),
  blocked("пробелы перед схемой и nip.io-имя на 127.0.0.1 — тот же суд по DNS", "  http://127.0.0.1.nip.io/", /SSRF|внутрен/),
  {
    tool: "app_launch",
    name: "пустое имя — ошибка, ничего не запущено",
    args: { app: "" },
    expect: { ok: false, resultIncludes: "not_found", effects: [{ none: "window.open" }], state: (s) => s.windows.length === 0 || "появилось окно" },
    coversTool: "app_launch",
  },
  {
    tool: "app_launch",
    name: "запуск под вуалью выделения обязан упереться в overlay_drawing (клиент: assertNoDrawingOverlay)",
    args: { app: "notepad" },
    before: [{ tool: "screen_selection", args: { op: "start" } }],
    skip: "пробел лаборатории: FakeDesktop app.launch не гейтится вуалью (настоящий launchApp зовёт assertNoDrawingOverlay); ждём veilGate в gui-windows.ts",
    expect: { ok: false, flags: { overlayDenied: true }, state: (s) => s.windows.length === 0 || "окно открылось под вуалью" },
    coversTool: "app_launch",
  },
];

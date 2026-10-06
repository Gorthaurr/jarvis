import type { DesktopWindow } from "../lib/contracts.js";
import { type DesktopCore, normPath } from "./core.js";
import { browserModel, NEWTAB } from "./gui-m-browser.js";
import { calcModel } from "./gui-m-calc.js";
import { explorerModel, explorerTitle } from "./gui-m-explorer.js";
import { genericModel } from "./gui-m-generic.js";
import { messengerModel } from "./gui-m-messenger.js";
import { notepadModel } from "./gui-m-notepad.js";
import type { Ctx, Model, Rect } from "./gui-model.js";
export interface AppSpec {
  process: string;
  title: (arg?: string) => string;
  rect: Rect;
  single?: boolean;
  /** Встроенное в Windows: запускается без записи в installedApps. */
  builtin?: boolean;
  make: (ctx: Ctx, w: DesktopWindow, arg?: string) => Model;
}

export const R = (w: number, h: number, x = 200, y = 100): Rect => ({ x, y, w, h });
export const gen = (process: string, title: string, rect = R(1000, 650), extra: Partial<AppSpec> = {}): AppSpec => ({ process, title: () => title, rect, make: (_c, w) => genericModel(w), ...extra });
export const browser = (process: string, brand: string): AppSpec => ({ process, title: () => `Новая вкладка - ${brand}`, rect: R(1400, 900, 60, 40), make: (c, w, url) => browserModel(c, w, url ?? NEWTAB) });
export const messenger = (process: string, chat = "Избранное"): AppSpec => ({ process, title: () => `${chat} — ${process}`, rect: R(1000, 700, 150, 60), single: true, make: (c, w) => messengerModel(c, w) });

export const APPS: Record<string, AppSpec> = {
  notepad: { process: "notepad", title: () => "Безымянный — Блокнот", rect: R(900, 600, 300, 150), builtin: true, make: (c, w, p) => notepadModel(c, w, p ? { path: p } : {}) },
  calc: { process: "CalculatorApp", title: () => "Калькулятор", rect: R(340, 560), single: true, builtin: true, make: calcModel },
  explorer: { process: "explorer", title: (p) => explorerTitle(normPath(p ?? "C:/Users/lab/Desktop"), "C:/Users/lab"), rect: R(1000, 650, 250, 120), builtin: true, make: (c, w, p) => explorerModel(c, w, p) },
  chrome: browser("chrome", "Google Chrome"),
  msedge: browser("msedge", "Microsoft Edge"),
  firefox: browser("firefox", "Mozilla Firefox"),
  telegram: messenger("Telegram"),
  discord: messenger("Discord"),
  whatsapp: messenger("WhatsApp"),
  viber: messenger("Viber"),
  slack: messenger("Slack"),
  steam: gen("steam", "Steam", R(1100, 700), { single: true }),
  spotify: gen("Spotify", "Spotify", R(1100, 700), { single: true }),
  obs64: gen("obs64", "OBS 30.2.3 - Профиль: Без названия", R(1100, 700), { single: true }),
  code: gen("Code", "Visual Studio Code", R(1300, 850, 100, 40)),
  winword: gen("WINWORD", "Документ1 - Word", R(1200, 800, 120, 60)),
  excel: gen("EXCEL", "Книга1 - Excel", R(1200, 800, 120, 60)),
  settings: gen("SystemSettings", "Параметры", R(1000, 700), { builtin: true, single: true }),
  taskmgr: gen("Taskmgr", "Диспетчер задач", R(900, 650), { builtin: true, single: true }),
  cmd: gen("cmd", "Командная строка", R(900, 500), { builtin: true }),
  powershell: gen("powershell", "Windows PowerShell", R(900, 500), { builtin: true }),
  mspaint: gen("mspaint", "Безымянный - Paint", R(1000, 700), { builtin: true }),
};

export const ALIASES: Record<string, string> = {
  блокнот: "notepad", заметки: "notepad", калькулятор: "calc", calculator: "calc", проводник: "explorer",
  браузер: "browser", browser: "browser", хром: "chrome", edge: "msedge", телеграм: "telegram", телеграмм: "telegram", телега: "telegram", тг: "telegram",
  дискорд: "discord", ватсап: "whatsapp", вайбер: "viber", слак: "slack", стим: "steam", спотифай: "spotify", obs: "obs64", "obs studio": "obs64",
  vscode: "code", "vs code": "code", ворд: "winword", word: "winword", эксель: "excel", настройки: "settings", параметры: "settings",
  "диспетчер задач": "taskmgr", "task manager": "taskmgr", "командная строка": "cmd", "командную строку": "cmd", терминал: "powershell", paint: "mspaint",
};

export const BROWSERS = new Set(["chrome", "msedge", "firefox"]);
export const TEXT_EXT = /\.(txt|md|log|json|csv|ini|cfg|xml|ya?ml|js|ts|py|bat|html?)$/iu;
export const isUrl = (s: string): boolean => /^[a-z][a-z0-9+.-]*:\/\/\S+/iu.test(s) || /^www\.\S+\.\S+/iu.test(s);

export const installed = (core: DesktopCore, k: string): boolean => [...core.installedApps].some((a) => a.toLowerCase() === k);

/** Приложение, «установленное» в seed, но без своей модели: универсальное окно с именем процесса. */
export const specOf = (key: string): AppSpec => APPS[key] ?? gen(key, key.charAt(0).toUpperCase() + key.slice(1), R(1000, 650));

/** Ключ реестра по имени; браузер по умолчанию — первый установленный. Нет в системе — null (→ not_found). */
export function keyFor(core: DesktopCore, raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\.exe$/u, "");
  const k = ALIASES[s] ?? s;
  if (!k) return null;
  if (k === "browser") return ["chrome", "msedge", "firefox"].find((b) => installed(core, b)) ?? null;
  const spec = APPS[k];
  if (spec) return spec.builtin || installed(core, k) || installed(core, spec.process.toLowerCase()) ? k : null;
  return installed(core, k) ? k : null;
}

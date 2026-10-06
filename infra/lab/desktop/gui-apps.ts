import { ALIASES, APPS, BROWSERS, isUrl, keyFor, specOf, TEXT_EXT } from "./gui-app-catalog.js";
/**
 * Реестр приложений FakeDesktop: имя (в т.ч. русское) → процесс, заголовок, размер и модель окна. Запуск создаёт окно с
 * состоянием; неустановленное приложение — честный not_found (закон 1: «нет» — это ответ, а не ok).
 */
import { riskyProcessCategory } from "@jarvis/shared";
import type { DesktopWindow } from "../lib/contracts.js";
import { type DesktopCore, normPath } from "./core.js";
import { type BrowserModel, browserModel } from "./gui-m-browser.js";
import { calcModel } from "./gui-m-calc.js";
import { explorerModel } from "./gui-m-explorer.js";
import { genericModel } from "./gui-m-generic.js";
import { messengerModel } from "./gui-m-messenger.js";
import { notepadModel } from "./gui-m-notepad.js";
import type { Ctx, Model, SpawnSpec } from "./gui-model.js";
import { ActionError, guiState, raise, tick, zOrder } from "./gui-state.js";

/** Модель для окна: уже созданная либо по процессу (окна из seed получают поведение при первом обращении). */
export function modelOf(ctx: Ctx, w: DesktopWindow): Model {
  const have = ctx.st.models.get(w);
  if (have) return have;
  const p = w.process.toLowerCase().replace(/\.exe$/u, "");
  let m: Model;
  if (p === "notepad") m = notepadModel(ctx, w);
  else if (/^(calc|calculator|calculatorapp)$/u.test(p)) m = calcModel(ctx, w);
  else if (p === "explorer") m = explorerModel(ctx, w);
  else if (/^(chrome|msedge|firefox|brave|opera|browser|vivaldi)$/u.test(p)) m = browserModel(ctx, w);
  else if (riskyProcessCategory(p)?.human === "мессенджер") m = messengerModel(ctx, w);
  else m = genericModel(w);
  ctx.st.models.set(w, m);
  return m;
}

export function spawn(ctx: Ctx, s: SpawnSpec): DesktopWindow {
  const { core, st } = ctx;
  const hwnd = core.nextHwnd();
  const off = (core.windows.size % 8) * 30;
  const base = s.rect ?? { x: 200 + off, y: 100 + off, w: 900, h: 600 };
  const w: DesktopWindow = { hwnd, pid: s.pid ?? core.nextPid(), process: s.process, title: s.title, text: s.text ?? "", rect: { ...base }, monitor: s.monitor ?? 1, minimized: false };
  core.windows.set(hwnd, w);
  raise(core, st, w);
  core.effect("window.open", { hwnd, pid: w.pid, process: w.process, title: w.title });
  if (s.model) st.models.set(w, s.model(w));
  return w;
}

export interface LaunchInfo {
  w: DesktopWindow;
  reused: boolean;
  display: string;
  /** Что реально ушло в ОС (для поля resolved). */
  resolved: string;
  kind: "exe" | "uri" | "path";
}

/** Открыть файл/каталог/URL в подходящем приложении. */
function openTarget(ctx: Ctx, target: string): LaunchInfo {
  const { core } = ctx;
  if (isUrl(target)) return launchKey(ctx, keyFor(core, "browser"), target.startsWith("www.") ? `https://${target}` : target, "uri");
  const p = normPath(target);
  if (core.fs.dirs.has(p)) return launchKey(ctx, "explorer", p, "path");
  const bytes = core.fs.files.get(p);
  if (!bytes) throw new ActionError(`не удалось запустить «${target}»: такого файла или каталога нет`, "not_found");
  if (TEXT_EXT.test(p)) {
    if (!keyFor(core, "notepad")) throw new ActionError(`нет приложения для «${target}»`, "not_found");
    const w = spawn(ctx, { process: "notepad", title: `${p.slice(p.lastIndexOf("/") + 1)} — Блокнот`, text: bytes.toString("utf8"), rect: APPS.notepad!.rect, model: (nw) => notepadModel(ctx, nw, { path: p }) });
    return { w, reused: false, display: "Блокнот", resolved: p, kind: "path" };
  }
  if (/\.docx?$/iu.test(p) && keyFor(core, "winword")) return launchKey(ctx, "winword", undefined, "path", p);
  if (/\.xlsx?$/iu.test(p) && keyFor(core, "excel")) return launchKey(ctx, "excel", undefined, "path", p);
  if (/\.pdf$/iu.test(p) && keyFor(core, "browser")) return launchKey(ctx, keyFor(core, "browser"), `file:///${p}`, "path");
  throw new ActionError(`нет приложения, которое открывает «${target}»`, "not_found");
}

function launchKey(ctx: Ctx, key: string | null, arg: string | undefined, kind: LaunchInfo["kind"], resolved?: string): LaunchInfo {
  const { core, st } = ctx;
  const spec = key ? specOf(key) : undefined;
  if (!key || !spec) throw new ActionError("не удалось запустить: подходящее приложение не установлено", "not_found");
  const same = zOrder(core, st).find((x) => x.process.toLowerCase() === spec.process.toLowerCase());
  // Браузер с адресом — новая вкладка в существующем окне; одиночные приложения (UWP, лаунчеры) — то же окно.
  if (same && (spec.single || (arg && BROWSERS.has(key)))) {
    if (arg && BROWSERS.has(key)) (ctx.model(same) as BrowserModel).openUrlInNewTab?.(arg);
    raise(core, st, same);
    return { w: same, reused: true, display: same.title, resolved: resolved ?? spec.process, kind };
  }
  const w = spawn(ctx, { process: spec.process, title: spec.title(arg), rect: spec.rect, model: (nw) => spec.make(ctx, nw, arg) });
  tick(core, 700);
  return { w, reused: false, display: spec.title(arg), resolved: resolved ?? `${spec.process}.exe`, kind };
}

/** app.launch / открытие из других окон: имя приложения, путь или URL. */
export function launch(ctx: Ctx, raw: string, arg?: string): LaunchInfo {
  const what = (arg ?? raw).trim();
  if (isUrl(what) || /[\\/]/u.test(what)) return openTarget(ctx, what);
  const key = keyFor(ctx.core, what);
  if (!key) throw new ActionError(`не удалось запустить «${what}»: приложение не найдено или не установлено`, "not_found");
  return launchKey(ctx, key, undefined, "exe");
}

export function makeCtx(core: DesktopCore): Ctx {
  const ctx: Ctx = { core, st: guiState(core), open: (app, arg) => launch(ctx, app, arg).w, spawn: (s) => spawn(ctx, s), model: (w) => modelOf(ctx, w) };
  return ctx;
}

/** Все процессы реестра, совпавшие с именем закрываемого приложения (вхождение как у настоящего closeApp). */
export function matchesProcess(process: string, name: string): boolean {
  const pn = process.toLowerCase().replace(/\.exe$/u, "");
  const n = (ALIASES[name.trim().toLowerCase()] ?? name.trim().toLowerCase()).replace(/\.exe$/u, "");
  const key = APPS[n]?.process.toLowerCase();
  return pn === n || pn === key || (n.length >= 4 && (pn.includes(n) || n.includes(pn)));
}

export const CRITICAL = new Set(["electron", "node", "jarvis", "explorer", "dwm", "winlogon", "wininit", "csrss", "smss", "services", "lsass", "svchost", "system", "registry", "conhost", "fontdrvhost", "sihost"]);

/** Имя приложения, как оно уйдёт в ОС: ключ реестра (русские алиасы раскрыты) либо исходная строка. */
export const resolveName = (core: DesktopCore, raw: string): string => keyFor(core, raw) ?? raw.trim();

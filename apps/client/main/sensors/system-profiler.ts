/**
 * Профилировщик окружения (§9, персонализация): САМ определяет, чем пользуется человек,
 * чтобы Джарвис подстраивался, а не работал по захардкоженным предположениям.
 *
 * Определяет: дефолтный браузер (из реестра UserChoice), установленные браузеры (с путём
 * профиля и поддержкой CDP), ключевые приложения. Результат уходит агенту в системный
 * промпт — модель видит окружение конкретного пользователя и адаптируется.
 *
 * Маппинг (ProgId→браузер, спеки путей) — ЧИСТЫЕ функции (тестируются). Доступ к реестру/
 * ФС — отдельный IO-слой.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface BrowserInfo {
  id: string;
  name: string;
  exe: string;
  /** Каталог профиля (реальные логины пользователя). */
  userDataDir: string;
  /** Управляем по Chrome DevTools Protocol (Chromium-семейство). Firefox — нет. */
  cdpCapable: boolean;
  isDefault: boolean;
}

export interface AppInfo {
  id: string;
  name: string;
  exe: string;
}

export interface SystemProfile {
  os: string;
  defaultBrowser?: BrowserInfo;
  browsers: BrowserInfo[];
  apps: AppInfo[];
}

interface BrowserSpec {
  id: string;
  name: string;
  /** Префиксы ProgId дефолтного браузера в реестре. */
  progIds: string[];
  /** Кандидаты пути exe (env-шаблоны раскрываются в resolve). */
  exe: string[];
  /** Каталог профиля (env-шаблон). */
  userData: string;
  cdpCapable: boolean;
}

const env = (k: string): string => process.env[k] ?? "";

/** Спеки известных браузеров. Чистые данные — основа маппинга. */
export const BROWSER_SPECS: readonly BrowserSpec[] = [
  {
    id: "chrome", name: "Google Chrome", progIds: ["ChromeHTML"],
    exe: [join(env("ProgramFiles"), "Google\\Chrome\\Application\\chrome.exe"), join(env("ProgramFiles(x86)"), "Google\\Chrome\\Application\\chrome.exe"), join(env("LOCALAPPDATA"), "Google\\Chrome\\Application\\chrome.exe")],
    userData: join(env("LOCALAPPDATA"), "Google\\Chrome\\User Data"), cdpCapable: true,
  },
  {
    id: "edge", name: "Microsoft Edge", progIds: ["MSEdgeHTM", "MSEdgeMHT"],
    exe: [join(env("ProgramFiles(x86)"), "Microsoft\\Edge\\Application\\msedge.exe"), join(env("ProgramFiles"), "Microsoft\\Edge\\Application\\msedge.exe")],
    userData: join(env("LOCALAPPDATA"), "Microsoft\\Edge\\User Data"), cdpCapable: true,
  },
  {
    id: "brave", name: "Brave", progIds: ["BraveHTML", "BraveSSHTM"],
    exe: [join(env("ProgramFiles"), "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), join(env("ProgramFiles(x86)"), "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), join(env("LOCALAPPDATA"), "BraveSoftware\\Brave-Browser\\Application\\brave.exe")],
    userData: join(env("LOCALAPPDATA"), "BraveSoftware\\Brave-Browser\\User Data"), cdpCapable: true,
  },
  {
    id: "yandex", name: "Yandex Browser", progIds: ["YandexHTML", "YandexBrowserHTML"],
    exe: [join(env("LOCALAPPDATA"), "Yandex\\YandexBrowser\\Application\\browser.exe")],
    userData: join(env("LOCALAPPDATA"), "Yandex\\YandexBrowser\\User Data"), cdpCapable: true,
  },
  {
    id: "opera", name: "Opera", progIds: ["OperaStable", "Opera"],
    exe: [join(env("LOCALAPPDATA"), "Programs\\Opera\\opera.exe"), join(env("LOCALAPPDATA"), "Programs\\Opera GX\\opera.exe")],
    userData: join(env("APPDATA"), "Opera Software\\Opera Stable"), cdpCapable: true,
  },
  {
    id: "vivaldi", name: "Vivaldi", progIds: ["VivaldiHTM"],
    exe: [join(env("LOCALAPPDATA"), "Vivaldi\\Application\\vivaldi.exe")],
    userData: join(env("LOCALAPPDATA"), "Vivaldi\\User Data"), cdpCapable: true,
  },
  {
    id: "firefox", name: "Mozilla Firefox", progIds: ["FirefoxURL"],
    exe: [join(env("ProgramFiles"), "Mozilla Firefox\\firefox.exe"), join(env("ProgramFiles(x86)"), "Mozilla Firefox\\firefox.exe")],
    userData: "", cdpCapable: false, // Firefox — не CDP (Marionette), для автоматизации не используем
  },
];

/** ProgId дефолтного браузера → id браузера (чистая). */
export function progIdToBrowserId(progId: string): string | undefined {
  const p = progId.trim();
  for (const spec of BROWSER_SPECS) {
    if (spec.progIds.some((x) => p.toLowerCase().startsWith(x.toLowerCase()))) return spec.id;
  }
  return undefined;
}

/** Собрать BrowserInfo из спеки (резолв exe через existsSync). null если exe нет. */
export function resolveBrowserInfo(id: string, isDefault: boolean): BrowserInfo | null {
  const spec = BROWSER_SPECS.find((s) => s.id === id);
  if (!spec) return null;
  const exe = spec.exe.find((p) => p && existsSync(p));
  if (!exe) return null;
  return { id: spec.id, name: spec.name, exe, userDataDir: spec.userData, cdpCapable: spec.cdpCapable, isDefault };
}

// ── IO: реестр и приложения ───────────────────────────────────

/** Прочитать ProgId дефолтного браузера из реестра (HKCU UserChoice). */
export async function readDefaultBrowserProgId(): Promise<string | undefined> {
  const key = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";
  const out = await regQuery(key, "ProgId");
  // Формат строки: "    ProgId    REG_SZ    ChromeHTML"
  const m = /ProgId\s+REG_SZ\s+(\S+)/i.exec(out);
  return m?.[1];
}

function regQuery(key: string, value: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("reg", ["query", key, "/v", value], { windowsHide: true });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { out += d; });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
    setTimeout(() => { try { child.kill(); } catch { /* */ } resolve(out); }, 4000).unref?.();
  });
}

/** Известные приложения (детектируем по присутствию exe). */
const APP_SPECS: ReadonlyArray<{ id: string; name: string; exe: string }> = [
  { id: "telegram", name: "Telegram", exe: join(env("APPDATA"), "Telegram Desktop\\Telegram.exe") },
  { id: "discord", name: "Discord", exe: join(env("LOCALAPPDATA"), "Discord\\Update.exe") },
  { id: "whatsapp", name: "WhatsApp", exe: join(env("LOCALAPPDATA"), "WhatsApp\\WhatsApp.exe") },
  { id: "spotify", name: "Spotify", exe: join(env("APPDATA"), "Spotify\\Spotify.exe") },
  { id: "vlc", name: "VLC", exe: join(env("ProgramFiles"), "VideoLAN\\VLC\\vlc.exe") },
  { id: "word", name: "Microsoft Word", exe: join(env("ProgramFiles"), "Microsoft Office\\root\\Office16\\WINWORD.EXE") },
  { id: "excel", name: "Microsoft Excel", exe: join(env("ProgramFiles"), "Microsoft Office\\root\\Office16\\EXCEL.EXE") },
  { id: "vscode", name: "VS Code", exe: join(env("LOCALAPPDATA"), "Programs\\Microsoft VS Code\\Code.exe") },
  { id: "steam", name: "Steam", exe: join(env("ProgramFiles(x86)"), "Steam\\steam.exe") },
];

/** Найти установленные приложения из APP_SPECS (по наличию exe). */
export function detectApps(): AppInfo[] {
  return APP_SPECS.filter((a) => a.exe && existsSync(a.exe)).map((a) => ({ id: a.id, name: a.name, exe: a.exe }));
}

/** Список установленных браузеров (любой exe из спеки присутствует). */
export function detectBrowsers(defaultId?: string): BrowserInfo[] {
  const list: BrowserInfo[] = [];
  for (const spec of BROWSER_SPECS) {
    const info = resolveBrowserInfo(spec.id, spec.id === defaultId);
    if (info) list.push(info);
  }
  return list;
}

/** Полный профиль окружения (для агента и браузерной автоматизации). */
export async function buildSystemProfile(): Promise<SystemProfile> {
  const progId = await readDefaultBrowserProgId();
  const defaultId = progId ? progIdToBrowserId(progId) : undefined;
  const browsers = detectBrowsers(defaultId);
  const defaultBrowser = browsers.find((b) => b.isDefault) ?? browsers[0];
  return { os: `${process.platform} ${process.arch}`, defaultBrowser, browsers, apps: detectApps() };
}

/**
 * Браузер для CDP-автоматизации: дефолтный, если он Chromium; иначе первый установленный
 * Chromium-браузер; иначе undefined (диспетчер откатится на простой запуск URL).
 */
export async function resolveAutomationBrowser(): Promise<BrowserInfo | undefined> {
  const profile = await buildSystemProfile();
  if (profile.defaultBrowser?.cdpCapable) return profile.defaultBrowser;
  return profile.browsers.find((b) => b.cdpCapable);
}

/** Краткая сводка окружения для системного промпта агента (чистая). */
export function formatProfileSummary(p: SystemProfile): string {
  const parts: string[] = [];
  if (p.defaultBrowser) {
    parts.push(`браузер по умолчанию — ${p.defaultBrowser.name}${p.defaultBrowser.cdpCapable ? "" : " (без авто-управления)"}`);
  }
  const others = p.browsers.filter((b) => !b.isDefault).map((b) => b.name);
  if (others.length) parts.push(`ещё установлены браузеры: ${others.join(", ")}`);
  if (p.apps.length) parts.push(`установленные приложения: ${p.apps.map((a) => a.name).join(", ")}`);
  return parts.length ? `${parts.join("; ")}.` : "";
}

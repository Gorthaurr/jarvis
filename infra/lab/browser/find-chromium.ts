/**
 * Разведка браузера для лаборатории: какой исполняемый файл Chromium/Chrome/Edge есть на машине.
 * Файл нужен ТОЛЬКО как программа для НОВОГО процесса с временным профилем: чужие запущенные Chrome (владельца) не
 * трогаем и не ищем среди процессов. Ничего не скачиваем и не ставим.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ChromiumInfo {
  path: string;
  kind: "chromium" | "chrome" | "edge";
  /** Версия из соседней папки установки (154.0.8037.58); "" — не определить. */
  version: string;
  /** Откуда взят: CHROME_PATH | playwright | puppeteer | Program Files. */
  source: string;
}

export interface ChromiumProbe {
  found: ChromiumInfo | null;
  /** Все проверенные кандидаты: для README и для сообщения «почему skip». */
  tried: Array<{ path: string; source: string; exists: boolean }>;
}

interface Candidate {
  path: string;
  source: string;
  kind: ChromiumInfo["kind"];
}

const dirsOf = (root: string | undefined): string[] => {
  try {
    return root && existsSync(root) ? readdirSync(root) : [];
  } catch {
    return [];
  }
};

/** Кэш браузеров Playwright/Puppeteer: свежая сборка первой (сортировка по имени папки — номера ревизий/версий). */
function cacheCandidates(env: NodeJS.ProcessEnv): Candidate[] {
  const local = env.LOCALAPPDATA;
  const home = env.USERPROFILE ?? env.HOME;
  const out: Candidate[] = [];
  for (const d of dirsOf(local && join(local, "ms-playwright")).filter((x) => /^chromium-\d+$/u.test(x)).sort().reverse()) {
    out.push({ path: join(local as string, "ms-playwright", d, "chrome-win", "chrome.exe"), source: "playwright", kind: "chromium" });
  }
  const pup = home && join(home, ".cache", "puppeteer", "chrome");
  for (const d of dirsOf(pup).sort().reverse()) out.push({ path: join(pup as string, d, "chrome-win64", "chrome.exe"), source: "puppeteer", kind: "chromium" });
  return out;
}

function candidates(env: NodeJS.ProcessEnv): Candidate[] {
  const pf = [env.ProgramFiles ?? "C:/Program Files", env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)"];
  return [
    ...(env.CHROME_PATH ? [{ path: env.CHROME_PATH, source: "CHROME_PATH", kind: "chrome" as const }] : []),
    ...cacheCandidates(env),
    ...pf.map((p) => ({ path: join(p, "Google/Chrome/Application/chrome.exe"), source: "Program Files", kind: "chrome" as const })),
    ...(env.LOCALAPPDATA ? [{ path: join(env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"), source: "LocalAppData", kind: "chrome" as const }] : []),
    { path: "/usr/bin/chromium", source: "usr/bin", kind: "chromium" },
    { path: "/usr/bin/google-chrome", source: "usr/bin", kind: "chrome" },
    ...pf.map((p) => ({ path: join(p, "Microsoft/Edge/Application/msedge.exe"), source: "Program Files", kind: "edge" as const })),
  ];
}

/** Версия установки: рядом с chrome.exe лежит папка с номером версии (у Chrome и Edge). */
export function versionNear(exe: string): string {
  const v = dirsOf(dirname(exe)).filter((d) => /^\d+\.\d+\.\d+\.\d+$/u.test(d));
  return v.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() ?? "";
}

/** Первый существующий браузер и список проверенных. `exists` — DI для тестов. */
export function probeChromium(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): ChromiumProbe {
  const tried: ChromiumProbe["tried"] = [];
  let found: ChromiumInfo | null = null;
  for (const c of candidates(env)) {
    const ok = exists(c.path);
    tried.push({ path: c.path, source: c.source, exists: ok });
    if (ok && !found) found = { path: c.path, kind: c.kind, version: exists === existsSync ? versionNear(c.path) : "", source: c.source };
  }
  return { found, tried };
}

export const findChromium = (env: NodeJS.ProcessEnv = process.env): ChromiumInfo | null => probeChromium(env).found;

/** Одна строка для skip/README: что выбрано или почему ничего. */
export function describeProbe(p: ChromiumProbe): string {
  if (p.found) return `${p.found.kind} ${p.found.version || "?"} (${p.found.source}): ${p.found.path}`;
  return `нет Chromium/Chrome/Edge (проверено ${p.tried.length} путей: ${[...new Set(p.tried.map((t) => t.source))].join(", ")}); задай CHROME_PATH`;
}

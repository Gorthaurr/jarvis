/**
 * Лончер браузера лаборатории: НОВЫЙ процесс Chrome/Chromium со ВРЕМЕННЫМ профилем, `--headless=new` (окон на ПК владельца
 * нет), отладка по ТРУБЕ (без порта), лаб-копия расширения через CDP `Extensions.loadUnpacked` (фирменный Chrome >= 137
 * игнорирует --load-extension). Сеть герметична: `--no-proxy-server` (системный прокси/VPN владельца мимо), имена хостов
 * фикстур -> 127.0.0.1:<порт фикстур>, всё прочее NOTFOUND — стенд не выходит в интернет.
 * Гасим ТОЛЬКО свой pid вместе с деревом; чужие chrome.exe (Chrome владельца) не ищем и не трогаем ни при каких условиях.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { MARKER, removeRunDir } from "../lib/server-dir.js";
import { isPidAlive, killTree, killTreeSync, sleep } from "../lib/server-proc.js";
import { type CdpPipe, pipeCdp } from "./cdp-pipe.js";
import type { ChromiumInfo } from "./find-chromium.js";

export interface LaunchOptions {
  chrome: ChromiumInfo;
  /** Распакованная лаб-копия расширения и её ID. */
  ext: { dir: string; extId: string };
  /** Каталог прогона браузера (ASCII, %TEMP%/jarvis-lab/chrome-<id>); профиль — внутри. */
  dir: string;
  /** Имена хостов фикстур -> 127.0.0.1:fixturePort. */
  fixtureHosts: string[];
  fixturePort: number;
  /** Ожидание service worker расширения, мс. */
  startupTimeoutMs?: number;
}

export interface LabBrowser {
  pid: number;
  extId: string;
  chrome: ChromiumInfo;
  cdp: CdpPipe;
  alive(): boolean;
  /** Выражение в service worker расширения (диагностика: chrome.tabs, состояние WS). */
  sw(expression: string): Promise<unknown>;
  close(): Promise<void>;
}

/** Правила резолвера: хосты фикстур -> loopback:порт, остальное NOTFOUND, loopback исключён (CDP/WS к лаб-серверу). */
export function hostRules(hosts: string[], port: number): string {
  return [...hosts.map((h) => `MAP ${h} 127.0.0.1:${port}`), "MAP * ~NOTFOUND", "EXCLUDE 127.0.0.1", "EXCLUDE localhost"].join(", ");
}

export function chromeArgs(o: Pick<LaunchOptions, "fixtureHosts" | "fixturePort">, profile: string): string[] {
  return [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
    `--host-resolver-rules=${hostRules(o.fixtureHosts, o.fixturePort)}`,
    "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`,
    "--disable-sync", "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--lang=ru-RU", "about:blank",
  ];
}

interface Target {
  targetId: string;
  type: string;
  url: string;
}

export async function launchBrowser(o: LaunchOptions): Promise<LabBrowser> {
  const profile = `${o.dir}/profile`;
  mkdirSync(profile, { recursive: true });
  writeFileSync(`${o.dir}/${MARKER}`, "lab-browser");
  const proc = spawn(o.chrome.path, chromeArgs(o, profile), { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
  const pid = proc.pid;
  if (!pid) throw new Error(`браузер не запустился: ${o.chrome.path}`);
  let exited = false;
  proc.once("exit", () => (exited = true));
  const onExit = (): void => killTreeSync(pid); // тест упал / процесс убит — браузер-сирота не остаётся
  process.once("exit", onExit);
  const cdp = pipeCdp(proc);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    process.off("exit", onExit);
    cdp.end();
    if (!(await killTree(pid))) throw new Error(`не удалось погасить браузер pid ${pid}`);
    await removeRunDir(o.dir);
  };
  try {
    const loaded = await cdp.send("Extensions.loadUnpacked", { path: o.ext.dir });
    if (loaded.error) throw new Error(`Extensions.loadUnpacked не сработал (${o.chrome.kind} ${o.chrome.version}): ${loaded.error.message}`);
    if (loaded.result?.id !== o.ext.extId) throw new Error(`ID расширения ${String(loaded.result?.id)} не совпал с ожидаемым ${o.ext.extId} — /ext его не допустит`);
    const session = await attachWorker(cdp, o.ext.extId, o.startupTimeoutMs ?? 15_000);
    const sw = async (expression: string): Promise<unknown> => {
      const m = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
      if (m.error) throw new Error(m.error.message);
      if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text);
      return m.result?.result?.value;
    };
    return { pid, extId: o.ext.extId, chrome: o.chrome, cdp, alive: () => !exited && isPidAlive(pid), sw, close };
  } catch (e) {
    await close().catch(() => undefined);
    throw e;
  }
}

/** Service worker цели появляется раньше, чем исполнился его скрипт: ждём, пока в нём есть chrome.tabs. */
async function attachWorker(cdp: CdpPipe, extId: string, timeoutMs: number): Promise<string> {
  const until = Date.now() + timeoutMs;
  let target: Target | undefined;
  while (!target && Date.now() < until) {
    const t = await cdp.send("Target.getTargets");
    target = ((t.result?.targetInfos ?? []) as Target[]).find((x) => x.type === "service_worker" && x.url.includes(extId));
    if (!target) await sleep(100);
  }
  if (!target) throw new Error(`service worker расширения не поднялся за ${timeoutMs / 1000} с`);
  const att = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const session = att.result?.sessionId as string | undefined;
  if (!session) throw new Error(`не подключился к service worker: ${att.error?.message ?? "нет sessionId"}`);
  while (Date.now() < until) {
    const r = await cdp.send("Runtime.evaluate", { expression: "typeof chrome === 'object' && Boolean(chrome.tabs)", returnByValue: true }, session);
    if (r.result?.result?.value === true) return session;
    await sleep(50);
  }
  throw new Error("в service worker так и не появился chrome.tabs");
}

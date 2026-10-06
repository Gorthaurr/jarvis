import type { DesktopCore } from "./core-types.js";
export type { AudioSession,DesktopCore,ErrCode,KindHandler,KindHandlers,Monitor,VirtualFs } from "./core-types.js";
export { normPath };
/**
 * Ядро FakeDesktop: общее СОСТОЯНИЕ «ПК владельца» и хелперы. Обработчики видов команд (gui-handlers.ts, system-handlers.ts,
 * ...) получают ядро и мутируют его; журнал эффектов (`effect`) — то, по чему eval проверяет ФАКТ, а не слова модели.
 * Никаких обращений к реальной ОС: файлы — в памяти (виртуальная ФС), процессы/окна — записи в Map.
 */
import type { DesktopEffect, DesktopSeed, DesktopSnapshot } from "../lib/contracts.js";

const normPath = (p: string): string => p.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^([a-z]):/u, (_m, d: string) => `${d.toUpperCase()}:`);

const DEFAULT_APPS = ["notepad", "calc", "explorer", "chrome", "code", "telegram", "discord", "steam", "obs64", "winword", "excel", "spotify"];

export function createDesktopCore(seed: DesktopSeed = {}): DesktopCore {
  let clock = 0;
  let hwndSeq = 1000;
  let pidSeq = 4000;
  let effectSeq = 0;

  const core: DesktopCore = {
    now: () => clock,
    advance: (ms) => {
      clock += Math.max(0, ms);
    },
    windows: new Map(),
    foreground: null,
    nextHwnd: () => (hwndSeq += 2),
    nextPid: () => (pidSeq += 4),
    monitors: [],
    fs: { home: "C:/Users/lab", files: new Map(), dirs: new Set() },
    clipboard: "",
    volume: 40,
    muted: false,
    media: { playing: false },
    locked: false,
    audioSessions: [],
    installedApps: new Set(),
    web: new Map(),
    effects: [],
    listeners: new Set(),
    effect(kind, detail = {}) {
      const e: DesktopEffect = { n: ++effectSeq, at: clock, kind, detail };
      core.effects.push(e);
      for (const l of core.listeners) l(e);
    },
    ok: (commandId, data, extra) => ({ commandId, ok: true, durationMs: extra?.durationMs ?? 1, ...(data !== undefined ? { data } : {}), ...(extra?.stepIndex !== undefined ? { stepIndex: extra.stepIndex } : {}) }),
    fail: (commandId, code, message, data) => ({ commandId, ok: false, durationMs: 1, error: { code, message }, ...(data !== undefined ? { data } : {}) }),
    snapshot() {
      const files: DesktopSnapshot["files"] = {};
      for (const [p, b] of core.fs.files) files[p] = isText(b) ? b.toString("utf8") : { binary: b.length };
      const processes: Record<string, number> = {};
      for (const w of core.windows.values()) processes[w.process] = (processes[w.process] ?? 0) + 1;
      return {
        windows: [...core.windows.values()].map((w) => ({ ...w, rect: { ...w.rect } })),
        foregroundHwnd: core.foreground,
        clipboard: core.clipboard,
        files,
        volume: core.volume,
        muted: core.muted,
        media: { ...core.media },
        locked: core.locked,
        processes,
        effects: core.effects.map((e) => ({ ...e, detail: { ...e.detail } })),
      };
    },
    reset(next = {}) {
      clock = 0;
      hwndSeq = 1000;
      pidSeq = 4000;
      effectSeq = 0;
      core.windows.clear();
      core.foreground = null;
      core.monitors = [
        { id: 1, x: 0, y: 0, w: 2560, h: 1440, dpi: 1.25, primary: true },
        { id: 2, x: 2560, y: 0, w: 1920, h: 1080, dpi: 1, primary: false },
      ];
      core.fs = { home: "C:/Users/lab", files: new Map(), dirs: new Set(["C:/Users/lab", "C:/Users/lab/Desktop", "C:/Users/lab/Documents", "C:/Users/lab/Downloads"]) };
      core.clipboard = next.clipboard ?? "";
      core.volume = next.volume ?? 40;
      core.muted = false;
      core.media = { playing: false };
      core.locked = false;
      core.audioSessions = [];
      core.installedApps = new Set(next.installedApps ?? DEFAULT_APPS);
      core.web = new Map(Object.entries(next.web ?? {}));
      core.effects = [];
      for (const [p, text] of Object.entries(next.files ?? {})) {
        const np = normPath(p.startsWith("/") || /^[A-Za-z]:/u.test(p) ? p : `${core.fs.home}/${p}`);
        core.fs.files.set(np, Buffer.from(text, "utf8"));
        let d = np.slice(0, np.lastIndexOf("/"));
        while (d.length > 2) {
          core.fs.dirs.add(d);
          d = d.slice(0, d.lastIndexOf("/"));
        }
      }
      for (const w of next.windows ?? []) {
        const hwnd = core.nextHwnd();
        core.windows.set(hwnd, {
          hwnd,
          pid: w.pid ?? core.nextPid(),
          process: w.process,
          title: w.title,
          text: w.text ?? "",
          rect: w.rect ?? { x: 100, y: 100, w: 1200, h: 800 },
          monitor: w.monitor ?? 1,
          minimized: w.minimized ?? false,
        });
        core.foreground = hwnd;
      }
    },
  };
  core.reset(seed);
  return core;
}

function isText(b: Buffer): boolean {
  for (let i = 0; i < Math.min(b.length, 4096); i += 1) if (b[i] === 0) return false;
  return true;
}

/** Подпорки тестов eval: контекст проверки из кусков, заглушки сервера/клиента, ход без обращения к серверу. */
import type { DesktopSnapshot, LabServer, TurnResult } from "../lib/contracts.js";
import type { EvalContext } from "./types.js";

export const emptySnap = (p: Partial<DesktopSnapshot> = {}): DesktopSnapshot => ({
  windows: [], foregroundHwnd: null, clipboard: "", files: {}, volume: 40, muted: false, media: { playing: false }, locked: false, processes: {}, effects: [], ...p,
});

export const mkTurn = (p: Partial<TurnResult> = {}): TurnResult => ({
  utterance: "", ok: true, ended: "idle", ms: 5, chat: [], answer: "", speech: { chunks: 0, bytes: 0 }, actions: [], confirms: [], tasks: [], cards: [], states: [], serverErrors: [], ...p,
});

export const stubServer = (p: Partial<LabServer> = {}): LabServer => ({
  id: "stub", url: "ws://127.0.0.1:0/ws", httpUrl: "http://127.0.0.1:0", port: 0, dir: "", dataDir: "", devToken: "t", pid: 0,
  logTail: () => "", metrics: () => [], health: async () => ({ ok: true, sessions: 0 }), stop: async () => undefined, ...p,
});

/** Контекст проверки: `before` по умолчанию = `desktop` (ничего не менялось), ходы — один по умолчанию. */
export function mkCtx(p: { desktop?: Partial<DesktopSnapshot>; before?: Partial<DesktopSnapshot>; turns?: Array<Partial<TurnResult>>; server?: LabServer; userId?: string } = {}): EvalContext {
  const desktop = emptySnap(p.desktop);
  const turns = (p.turns?.length ? p.turns : [{}]).map(mkTurn);
  return { desktop, before: emptySnap(p.before ?? p.desktop), turns, turn: turns[turns.length - 1]!, marks: turns.map(() => desktop), server: p.server ?? stubServer(), userId: p.userId ?? "u-1" };
}

export const win = (p: Partial<DesktopSnapshot["windows"][number]> & { title: string; process: string }): DesktopSnapshot["windows"][number] => ({
  hwnd: 1002, pid: 4004, text: "", rect: { x: 0, y: 0, w: 100, h: 100 }, monitor: 1, minimized: false, ...p,
});

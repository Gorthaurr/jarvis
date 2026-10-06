/**
 * Мини-«ПК» для тестов механики (харнесс, раннер): только `handle`, остальное — заглушки контракта.
 * Не зависит от наполненности настоящего FakeDesktop, поэтому тесты харнесса не ломаются, когда соседи меняют обработчики.
 */
import type { ActionCommand, ActionResult } from "../../../packages/protocol/src/index.js";
import type { DesktopEffect, DesktopSnapshot, FakeDesktop } from "../lib/contracts.js";

export type Handle = (cmd: ActionCommand, meta: { commandId: string; timeoutMs: number }) => Promise<ActionResult> | ActionResult;

export const okResult = (commandId: string, data?: unknown): ActionResult => ({ commandId, ok: true, durationMs: 1, ...(data !== undefined ? { data } : {}) });

export function miniDesktop(handle: Handle, snapshot?: () => Partial<DesktopSnapshot>): FakeDesktop {
  const listeners = new Set<(e: DesktopEffect) => void>();
  const empty: DesktopSnapshot = { windows: [], foregroundHwnd: null, clipboard: "", files: {}, volume: 0, muted: false, media: { playing: false }, locked: false, processes: {}, effects: [] };
  return {
    handle: async (c, m) => handle(c, m),
    snapshot: () => ({ ...empty, ...(snapshot?.() ?? {}) }),
    reset: () => {},
    advance: () => {},
    userAction: () => {},
    onEffect: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

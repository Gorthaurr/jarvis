/**
 * FakeDesktop — «ПК владельца» с состоянием. Собирает обработчики видов команд (GUI, система/ФС, сервисы) над общим ядром.
 * Неизвестный вид → честная ошибка `runtime` (как у настоящего клиента), а не ложный успех (закон 1: честность исхода).
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { DesktopEffect, DesktopSeed, FakeDesktop } from "../lib/contracts.js";
import { type KindHandler, type KindHandlers, createDesktopCore } from "./core.js";
import { guiHandlers } from "./gui-handlers.js";
import { serviceHandlers } from "./service-handlers.js";
import { systemHandlers } from "./system-handlers.js";

export * from "./core.js";

export function createFakeDesktop(seed?: DesktopSeed): FakeDesktop {
  const core = createDesktopCore(seed);
  const table: KindHandlers = {};
  const dispatch: KindHandler = (cmd, meta) => handle(cmd, meta);
  Object.assign(table, guiHandlers(core, dispatch), systemHandlers(core, dispatch), serviceHandlers(core, dispatch));

  async function handle(cmd: ActionCommand, meta: { commandId: string; timeoutMs: number }): Promise<ActionResult> {
    const h = table[cmd.kind];
    if (!h) return core.fail(meta.commandId, "runtime", `неизвестная операция клиента: ${cmd.kind}`);
    try {
      return await h(cmd, meta);
    } catch (e) {
      return core.fail(meta.commandId, "runtime", `сбой обработчика ${cmd.kind}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    handle,
    snapshot: () => core.snapshot(),
    reset: (s) => core.reset(s),
    advance: (ms) => core.advance(ms),
    userAction: (kind, detail) => core.effect(`user.${kind}`, detail ?? {}),
    onEffect(cb: (e: DesktopEffect) => void) {
      core.listeners.add(cb);
      return () => core.listeners.delete(cb);
    },
  };
}

/** Виды команд, которые ЭТА реализация умеет (для матрицы покрытия): собирается из таблицы обработчиков. */
export function supportedKinds(): string[] {
  const core = createDesktopCore();
  const d: KindHandler = async (_c, m) => core.ok(m.commandId);
  return Object.keys({ ...guiHandlers(core, d), ...systemHandlers(core, d), ...serviceHandlers(core, d) }).sort();
}

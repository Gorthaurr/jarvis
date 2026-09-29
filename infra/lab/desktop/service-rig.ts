/** Стенд тестов сервисной группы: ядро FakeDesktop + обработчики, вызов команды одной строкой. Не часть рантайма лаборатории. */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { type DesktopCore, type KindHandler, createDesktopCore } from "./core.js";
import { type ServiceOptions, resetServiceOptions, serviceHandlers } from "./service-handlers.js";
import type { DesktopSeed } from "../lib/contracts.js";

export interface Rig {
  core: DesktopCore;
  call: (cmd: ActionCommand) => Promise<ActionResult>;
  /** Подменить «остальной рабочий стол» для skill.execute (шаги уходят в dispatch). */
  setDispatch: (fn: KindHandler) => void;
  sent: Array<{ cmd: ActionCommand; commandId: string }>;
  kinds: (k: string) => Array<Record<string, unknown>>;
}

export function rig(seed?: DesktopSeed, options?: Partial<ServiceOptions>): Rig {
  resetServiceOptions();
  const core = createDesktopCore(seed);
  let n = 0;
  const sent: Rig["sent"] = [];
  let dispatchFn: KindHandler = (_c, m) => core.ok(m.commandId);
  const table = serviceHandlers(core, (c, m) => (sent.push({ cmd: c, commandId: m.commandId }), dispatchFn(c, m)), options);
  return {
    core,
    sent,
    setDispatch: (fn) => void (dispatchFn = fn),
    call: async (cmd) => {
      const h = table[cmd.kind];
      if (!h) throw new Error(`нет обработчика ${cmd.kind}`);
      return h(cmd, { commandId: `c${++n}`, timeoutMs: 15_000 });
    },
    kinds: (k) => core.effects.filter((e) => e.kind === k).map((e) => e.detail),
  };
}

export const errOf = (r: ActionResult): string => r.error?.message ?? "";

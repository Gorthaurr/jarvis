/**
 * Общая обвязка обработчиков системной половины FakeDesktop. Настоящий клиентский dispatch превращает ЛЮБОЕ исключение
 * актуатора fs/system/audio в `error.runtime` с текстом `e.message` (коды not_found/denied там только у app/window/act) —
 * поэтому обработчик бросает обычный Error, а обёртка отдаёт runtime БЕЗ приставки «сбой обработчика» из index.ts.
 */
import type { ActionCommand } from "@jarvis/protocol";
import type { DesktopCore, KindHandler } from "./core.js";

export type CmdOf<K extends ActionCommand["kind"]> = Extract<ActionCommand, { kind: K }>;

export function handler<K extends ActionCommand["kind"]>(
  core: DesktopCore,
  fn: (cmd: CmdOf<K>) => unknown,
): KindHandler {
  return (cmd, meta) => {
    try {
      return core.ok(meta.commandId, fn(cmd as CmdOf<K>));
    } catch (e) {
      return core.fail(meta.commandId, "runtime", e instanceof Error ? e.message : String(e));
    }
  };
}

export const round = (n: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
};

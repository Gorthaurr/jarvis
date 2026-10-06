/** Общий набор для тестов GUI-половины FakeDesktop: рабочий стол, запуск команд и разбор ответов. Не тест сам по себе. */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { DesktopSeed, FakeDesktop } from "../lib/contracts.js";
import { createFakeDesktop } from "./index.js";

export interface Kit {
  d: FakeDesktop;
  /** Выполнить команду как клиент; поля команды — «как от сервера». */
  run(cmd: Record<string, unknown>): Promise<ActionResult>;
  /** ok-результат: data (тест падает, если команда провалилась). */
  ok(cmd: Record<string, unknown>): Promise<Record<string, any>>;
  /** Провал: код и сообщение (тест падает, если команда прошла). */
  fail(cmd: Record<string, unknown>): Promise<{ code: string; message: string; data?: any; injected: boolean }>;
  win(process: string): ReturnType<FakeDesktop["snapshot"]>["windows"][number];
  effects(kind: string): Array<{ kind: string; detail: Record<string, unknown> }>;
}

let seq = 0;

export function kit(seed?: DesktopSeed): Kit {
  const d = createFakeDesktop(seed);
  const run = (cmd: Record<string, unknown>): Promise<ActionResult> => d.handle(cmd as ActionCommand, { commandId: `t${++seq}`, timeoutMs: 15_000 });
  return {
    d,
    run,
    async ok(cmd) {
      const r = await run(cmd);
      if (!r.ok) throw new Error(`${String(cmd.kind)} провалилась: ${r.error?.code} ${r.error?.message}`);
      return (r.data ?? {}) as Record<string, any>;
    },
    async fail(cmd) {
      const r = await run(cmd);
      if (r.ok) throw new Error(`${String(cmd.kind)} прошла, а должна была провалиться: ${JSON.stringify(r.data).slice(0, 200)}`);
      return { code: r.error!.code, message: r.error!.message, data: r.data, injected: r.stepActionInjected === true };
    },
    win(process) {
      const w = d.snapshot().windows.find((x) => x.process.toLowerCase() === process.toLowerCase());
      if (!w) throw new Error(`нет окна процесса ${process}: ${JSON.stringify(d.snapshot().windows.map((x) => x.process))}`);
      return w;
    },
    effects: (kind) => d.snapshot().effects.filter((e) => e.kind === kind),
  };
}

/** Грант одобрения §14, как его выдаёт сервер после «да» владельца. */
export const grant = (signature: string, process: string, count = 1, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  approval: { grants: [{ signature, process, count, ...extra }], expiresAt: Date.now() + 60_000 },
});

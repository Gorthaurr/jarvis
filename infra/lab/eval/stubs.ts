/**
 * Заглушки швов раннера для юнитов: сервер без процесса, клиент со сценарным «мозгом» (функция, которая двигает НАСТОЯЩИЙ
 * FakeDesktop командами клиента и возвращает ход). Проверяют раннер и проверки быстро, без спавна и без подписки.
 */
import type { ActionCommand } from "@jarvis/protocol";
import { createFakeDesktop } from "../desktop/index.js";
import type { FakeDesktop, LabServer, TurnResult } from "../lib/contracts.js";
import type { LabClientConnectOptions } from "../lib/client.js";
import type { LabServerStartOptions } from "../lib/server.js";
import { mkTurn, stubServer } from "./testkit.js";
import type { EvalDeps } from "./types.js";

export interface BrainEnv {
  text: string;
  /** Номер реплики в разговоре с 0. */
  step: number;
  desktop: FakeDesktop;
  opts: LabClientConnectOptions;
  /** Отправить команду клиенту ПК и получить запись для TurnResult.actions. */
  act(cmd: Record<string, unknown>): Promise<TurnResult["actions"][number]>;
}
export type Brain = (e: BrainEnv) => Promise<Partial<TurnResult>> | Partial<TurnResult>;

export interface StubLog {
  started: LabServerStartOptions[];
  stopped: number;
  connects: LabClientConnectOptions[];
  desktops: FakeDesktop[];
  closed: number;
  said: Array<{ text: string; opts: unknown }>;
}

export function stubDeps(brain: Brain, o: { server?: Partial<LabServer>; connectError?: (n: number) => Error | undefined } = {}): { deps: EvalDeps; log: StubLog } {
  const log: StubLog = { started: [], stopped: 0, connects: [], desktops: [], closed: 0, said: [] };
  const deps: EvalDeps = {
    startServer: async (so) => {
      log.started.push(so);
      return stubServer({ ...o.server, stop: async () => { log.stopped += 1; await o.server?.stop?.(); } });
    },
    createDesktop: (seed) => {
      const d = createFakeDesktop(seed);
      log.desktops.push(d);
      return d;
    },
    connectClient: async (co) => {
      log.connects.push(co);
      const err = o.connectError?.(log.connects.length);
      if (err) throw err;
      let step = 0;
      return {
        sessionId: "s", userToken: co.token ?? "",
        say: async (text, sopts) => {
          log.said.push({ text, opts: sopts });
          const act = async (cmd: Record<string, unknown>) => {
            const t0 = Date.now();
            const result = await co.desktop.handle(cmd as unknown as ActionCommand, { commandId: `c${step}`, timeoutMs: 1000 });
            return { cmd: cmd as unknown as ActionCommand, result, ms: Date.now() - t0 };
          };
          return mkTurn({ utterance: text, ...(await brain({ text, step: step++, desktop: co.desktop, opts: co, act })) });
        },
        events: () => [], send: () => undefined, close: async () => void (log.closed += 1),
      };
    },
  };
  return { deps, log };
}

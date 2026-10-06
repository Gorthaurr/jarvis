/**
 * Мост «сервер → FakeDesktop»: `ActuatorSink.sendAction`, как его исполняет Session по WS, но без сокета.
 *  - команда и результат идут через JSON (как по проводу): недоступные проводу значения (undefined-поля, функции,
 *    циклы, BigInt) проявятся в лаборатории, а не на живом клиенте;
 *  - `result.commandId` обязан совпасть с посланным: Session молча игнорирует чужой id и ждёт таймаут — мы это
 *    показываем ЧЕСТНОЙ ошибкой `runtime`, а не «чиним» id (иначе баг обработчика FakeDesktop спрятан);
 *  - зависший обработчик даёт `timeout`, а не подвешивает тест.
 */
import type { ActionCommand, ActionResult } from "../../../packages/protocol/src/index.js";
import { newId } from "../../../packages/protocol/src/index.js";
import type { DesktopEffect, FakeDesktop } from "../lib/contracts.js";

export interface ActionRecord {
  cmd: ActionCommand;
  result: ActionResult;
  ms: number;
}

export interface ActionBridge {
  sendAction(cmd: ActionCommand, timeoutMs?: number): Promise<ActionResult>;
  records(): ActionRecord[];
  /** Эффекты FakeDesktop с последнего reset. */
  effects(): DesktopEffect[];
  reset(): void;
  dispose(): void;
}

const fail = (commandId: string, code: "runtime" | "timeout", message: string): ActionResult => ({ commandId, ok: false, durationMs: 0, error: { code, message } });

export function createActionBridge(desktop: FakeDesktop, opts: { labTimeoutMs?: number } = {}): ActionBridge {
  const labTimeout = opts.labTimeoutMs ?? 10_000;
  let records: ActionRecord[] = [];
  let effects: DesktopEffect[] = [];
  const off = desktop.onEffect((e) => {
    effects.push(e);
  });

  return {
    async sendAction(cmd, timeoutMs = labTimeout) {
      const commandId = newId();
      const t0 = Date.now();
      let wire: ActionCommand;
      try {
        wire = JSON.parse(JSON.stringify(cmd)) as ActionCommand;
      } catch (e) {
        const r = fail(commandId, "runtime", `команду не сериализовать в JSON: ${e instanceof Error ? e.message : String(e)}`);
        records.push({ cmd, result: r, ms: 0 });
        return r;
      }
      const limit = Math.min(timeoutMs, labTimeout);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<ActionResult>((res) => {
        // Не unref: этот таймер — единственное, что разбудит вызов, если обработчик завис; после гонки он гасится в finally.
        timer = setTimeout(() => res(fail(commandId, "timeout", `нет result за ${limit}ms (лабораторный таймаут)`)), limit);
      });
      let result: ActionResult;
      try {
        const raw = await Promise.race([desktop.handle(wire, { commandId, timeoutMs }), timeout]);
        result = JSON.parse(JSON.stringify(raw)) as ActionResult;
        if (result.commandId !== commandId) result = fail(commandId, "runtime", `обработчик вернул commandId=${String(result.commandId)}, ждали ${commandId} — на проводе результат был бы потерян`);
      } catch (e) {
        result = fail(commandId, "runtime", `обработчик упал или вернул несериализуемое: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
      records.push({ cmd: wire, result, ms: Date.now() - t0 });
      return result;
    },
    records: () => records.map((r) => ({ ...r })),
    effects: () => effects.map((e) => ({ ...e, detail: { ...e.detail } })),
    reset() {
      records = [];
      effects = [];
    },
    dispose: off,
  };
}

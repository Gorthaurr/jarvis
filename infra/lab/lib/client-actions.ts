/**
 * Исполнение action.command лаб-клиентом. Ровно один action.result на команду (commandId = id конверта), как у настоящего
 * клиента (transport.handleActionCommand): дедуп повторного кадра, гонка с timeoutMs, исключение → runtime.
 * Fault-инъекции моделируют сбои клиента: error / timeout (клиентский, ответом) / slow / drop_socket (обрыв, результат
 * уходит после resume — как outbox настоящего клиента). Ложного ok здесь нет: результат даёт только FakeDesktop.
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { DEFAULT_ACTION_TIMEOUT_MS } from "@jarvis/protocol";
import type { FakeDesktop, LabClientOptions } from "./contracts.js";

export type Fault = NonNullable<LabClientOptions["faults"]>[number];

/** Счётчик срабатываний: у fault с `times` остаётся столько раз, без `times` — всегда. */
export function pickFault(faults: Fault[], kind: string): Fault | undefined {
  const f = faults.find((x) => (x.kind === kind || x.kind === "*") && (x.times === undefined || x.times > 0));
  if (f && f.times !== undefined) f.times -= 1;
  return f;
}

const fail = (commandId: string, code: NonNullable<ActionResult["error"]>["code"], message: string, durationMs: number): ActionResult => ({
  commandId,
  ok: false,
  error: { code, message },
  durationMs,
});

export interface ActionHooks {
  /** Обрыв сокета по fault drop_socket; вернуть промис, который резолвится, когда связь восстановлена (результат уйдёт после). */
  dropSocket(offlineMs: number): Promise<void>;
  /** Отправить результат (в журнал + в сокет). */
  sendResult(r: ActionResult): void;
}

export class ActionRunner {
  private readonly seen = new Set<string>();

  constructor(
    private readonly desktop: FakeDesktop,
    private readonly faults: Fault[],
    private readonly hooks: ActionHooks,
  ) {}

  /** Обработать команду. Повтор того же commandId игнорируется (сервер мог дослать кадр после resume). */
  async run(commandId: string, payload: ActionCommand & { timeoutMs?: number }): Promise<void> {
    if (this.seen.has(commandId)) return;
    this.seen.add(commandId);
    const timeoutMs = typeof payload.timeoutMs === "number" && payload.timeoutMs > 0 ? payload.timeoutMs : DEFAULT_ACTION_TIMEOUT_MS;
    const started = Date.now();
    const fault = pickFault(this.faults, payload.kind);
    if (fault?.mode === "error") {
      return this.hooks.sendResult(fail(commandId, "runtime", `lab fault: клиент отказал на ${payload.kind}`, Date.now() - started));
    }
    if (fault?.mode === "timeout") {
      if (fault.ms) await new Promise((r) => setTimeout(r, fault.ms));
      return this.hooks.sendResult(fail(commandId, "timeout", `lab fault: клиентский таймаут ${payload.kind}`, Date.now() - started));
    }
    let offline: Promise<void> | undefined;
    if (fault?.mode === "drop_socket") offline = this.hooks.dropSocket(fault.ms ?? 300);
    if (fault?.mode === "slow") await new Promise((r) => setTimeout(r, fault.ms ?? 1000));
    const result = await this.execute(commandId, payload, timeoutMs, started);
    if (offline) await offline; // результат в outbox до восстановления связи
    this.hooks.sendResult(result);
  }

  private async execute(commandId: string, payload: ActionCommand, timeoutMs: number, started: number): Promise<ActionResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<ActionResult>((resolve) => {
        timer = setTimeout(() => resolve(fail(commandId, "timeout", `клиент не уложился в ${timeoutMs} мс (${payload.kind})`, timeoutMs)), timeoutMs);
      });
      const r = await Promise.race([this.desktop.handle(payload, { commandId, timeoutMs }), timedOut]);
      // commandId обязан совпасть с id конверта: подменяем, чтобы кривой обработчик не оставил команду без ответа.
      return { ...r, commandId, durationMs: typeof r.durationMs === "number" ? r.durationMs : Date.now() - started };
    } catch (e) {
      return fail(commandId, "runtime", `сбой обработчика ${payload.kind}: ${e instanceof Error ? e.message : String(e)}`, Date.now() - started);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

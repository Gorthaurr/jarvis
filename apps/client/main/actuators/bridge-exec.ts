/**
 * W2 П1: исполнение команды SDK-моста — ПОСЛЕ allowlist видов (act-bridge.ts), ДО актуаторного dispatch.
 *
 *  - N-3: `approval` из тела срезается — одобрение ставит только сервер, и читает его рубеж лишь из области
 *    транспорта (прежний флаг `commitApproved` удалён из протокола в интеграции W2 — его не читает никто); команда моста исполняется в области `bridge` без одобрения (даже изнутри code_run);
 *  - N-4 / №17: `app.close{force}` и `app.launch` со схемой URI (skype:, tg:, zoommtg:, mailto:…) — отказ;
 *  - локальный вид `ui.find` (G-22) — поиск цели лестницей act, без dispatch.
 * §14/§0/своё окно здесь НЕ судятся: мост идёт в те же актуаторы, и каждую инжекцию судит рубеж (inject.ts).
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { runWithoutApproval } from "./approval-scope.js";
import { bridgeFind } from "./bridge-find.js";
import { closeDenial, launchDenial } from "./bridge-uri.js";

const log = createLogger("actuator:act-bridge");

/** Виды, которые мост исполняет сам (не ActionCommand протокола). */
export const BRIDGE_LOCAL_KINDS: ReadonlySet<string> = new Set(["ui.find"]);

/** Поля, которые из тела моста в команду не попадают никогда (ставит только сервер). */
const SERVER_ONLY_FIELDS: readonly string[] = ["approval"];

export type BridgeDispatch = (commandId: string, cmd: ActionCommand) => Promise<ActionResult>;

const denied = (commandId: string, message: string): ActionResult => ({ commandId, ok: false, error: { code: "denied", message }, durationMs: 0 });

/** Команда моста без серверных полей. */
export function stripServerFields(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  for (const f of SERVER_ONLY_FIELDS) delete out[f];
  return out;
}

async function exec(dispatch: BridgeDispatch, commandId: string, body: Record<string, unknown>): Promise<ActionResult> {
  if (body.kind === "ui.find") return bridgeFind(commandId, body);
  const denial = body.kind === "app.close" ? closeDenial(body) : body.kind === "app.launch" ? launchDenial(body.app, "app.launch") : null;
  if (denial) {
    log.warn("act-bridge: отказ", { kind: body.kind });
    return denied(commandId, denial);
  }
  return dispatch(commandId, body as unknown as ActionCommand);
}

/** Исполнитель моста: срез серверных полей → область без одобрения → локальные виды/отказы → dispatch. */
export function bridgeExecutor(dispatch: BridgeDispatch): BridgeDispatch {
  return (commandId, cmd) => runWithoutApproval("bridge", () => exec(dispatch, commandId, stripServerFields(cmd as unknown as Record<string, unknown>)), commandId);
}

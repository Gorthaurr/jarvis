/**
 * Обвязка обработчика GUI-команды: контекст, честные ошибки протокола, вуаль, USER_BUSY, виртуальная длительность.
 * Тело обработчика бросает ActionError (код/данные/«ушло») или обычную Error (→ runtime, текст как у актуатора).
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { DesktopCore, KindHandler } from "./core.js";
import { makeCtx } from "./gui-apps.js";
import type { Ctx } from "./gui-model.js";
import { ActionError } from "./gui-state.js";

export type Body<K extends ActionCommand["kind"]> = (cmd: Extract<ActionCommand, { kind: K }>, ctx: Ctx) => unknown | Promise<unknown>;

const USER_ACTIVE_MS = 4000;
const PHYSICAL = new Set<string>(["input.type", "input.key", "input.click", "input.mouse"]);
const VISUAL_WAIT = new Set(["ui", "text"]);

export function failFrom(core: DesktopCore, commandId: string, e: unknown): ActionResult {
  if (e instanceof ActionError) {
    const r = core.fail(commandId, e.code, e.message, e.data);
    return e.injected ? { ...r, stepActionInjected: true } : r;
  }
  return core.fail(commandId, "runtime", e instanceof Error ? e.message : String(e));
}

/** Результат снят под вуалью режима выделения — честно помечаем (сенсоры видят её, а не приложения). */
function veilRelevant(cmd: ActionCommand): boolean {
  if (cmd.kind === "wait.for") return VISUAL_WAIT.has(cmd.condition.kind);
  if (cmd.kind === "ui.snapshot") return typeof cmd.pid !== "number";
  if (cmd.kind === "screen.selection") return cmd.op === "view";
  if (cmd.kind === "context.read") return cmd.scope !== "selection";
  return cmd.kind === "screen.capture" || cmd.kind === "screen.ocr" || cmd.kind === "screen.probe";
}

export function guarded<K extends ActionCommand["kind"]>(core: DesktopCore, body: Body<K>): KindHandler {
  return async (cmd, meta) => {
    const t0 = core.now();
    try {
      const ctx = makeCtx(core);
      const proactive = cmd.origin === "proactive" || cmd.proactive === true;
      if (proactive && PHYSICAL.has(cmd.kind) && core.now() - ctx.st.ownerInputAt < USER_ACTIVE_MS) {
        throw new ActionError(
          "USER_BUSY: пользователь сам за вводом, физическую мышь/клавиатуру сейчас не трогаю. НЕ сдавайся и НЕ перекладывай на пользователя: если это ВЕБ — сделай через browser_open/browser_act (они его не потревожат); иначе повтори через пару секунд.",
          "denied",
        );
      }
      const veiledBefore = ctx.st.drawing;
      let data = await body(cmd as Extract<ActionCommand, { kind: K }>, ctx);
      if ((veiledBefore || ctx.st.drawing) && veilRelevant(cmd) && data && typeof data === "object") {
        data = { ...(data as Record<string, unknown>), overlayDrawing: true, ...(cmd.kind === "wait.for" ? { unknown: true } : {}) };
      }
      return core.ok(meta.commandId, data, { durationMs: Math.max(1, core.now() - t0) });
    } catch (e) {
      return failFrom(core, meta.commandId, e);
    }
  };
}

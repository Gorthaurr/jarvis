/**
 * Ввод: input.type / input.key / input.click / input.mouse и gui.act — обвязка над gui-input, gui-click, gui-act.
 * Наблюдение (дельта окна) прикладывается к результату, как у fused-observe настоящего клиента.
 */
import type { DesktopCore, KindHandler, KindHandlers } from "./core.js";
import { type ActCmd, makeAct } from "./gui-act.js";
import { click, mouse } from "./gui-click.js";
import { scopeOf } from "./gui-guard.js";
import { pressKey, typeText } from "./gui-input.js";
import { guarded } from "./gui-run.js";
import { foregroundWindow } from "./gui-state.js";
import { fingerprint, observe } from "./gui-tree.js";
import { makeWaiter } from "./gui-wait.js";

export function ioHandlers(core: DesktopCore, dispatch: KindHandler): KindHandlers {
  const act = makeAct(makeWaiter(dispatch));
  return {
    "input.type": guarded<"input.type">(core, (cmd, ctx) => {
      const before = fingerprint(ctx, foregroundWindow(core));
      typeText(ctx, cmd.text, scopeOf(cmd));
      const observation = observe(ctx, before);
      return observation ? { observation } : undefined;
    }),

    "input.key": guarded<"input.key">(core, (cmd, ctx) => {
      const before = fingerprint(ctx, foregroundWindow(core));
      pressKey(ctx, cmd.combo, cmd.mode, scopeOf(cmd));
      if (cmd.mode === "down" || cmd.mode === "up") return undefined; // середина жеста — наблюдение неуместно
      const observation = observe(ctx, before);
      return observation ? { observation } : undefined;
    }),

    "input.click": guarded<"input.click">(core, (cmd, ctx) => {
      const before = fingerprint(ctx, foregroundWindow(core));
      const clicked = click(ctx, cmd.target, cmd.method ?? "silent", cmd.button ?? "left", Math.max(1, Math.min(3, cmd.count ?? 1)), scopeOf(cmd));
      const observation = observe(ctx, before);
      return observation ? { ...clicked, observation } : clicked;
    }),

    "input.mouse": guarded<"input.mouse">(core, (cmd, ctx) => {
      const before = fingerprint(ctx, foregroundWindow(core));
      mouse(ctx, cmd, scopeOf(cmd));
      // Наблюдение — для завершённых жестов (drag/wheel/up); move/down — середина жеста.
      if (cmd.op === "move" || cmd.op === "down") return { op: cmd.op };
      const observation = observe(ctx, before);
      return observation ? { op: cmd.op, observation } : { op: cmd.op };
    }),

    "gui.act": guarded<"gui.act">(core, (cmd, ctx) => act(ctx, cmd as ActCmd, scopeOf(cmd))),
  };
}

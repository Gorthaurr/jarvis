/**
 * Клавиатурный ввод FakeDesktop: input.type / input.key. Честность: нет окна в фокусе — ошибка (нажатия некуда), не «ok»;
 * окно есть, но поле не принимает — ok с `accepted:false` в эффекте (так ведёт себя и настоящий SendInput).
 */
import { isBlockedCombo, normalizeCombo } from "@jarvis/shared";
import type { DesktopWindow } from "../lib/contracts.js";
import { type Fact, type Scope, judge } from "./gui-guard.js";
import type { Ctx } from "./gui-model.js";
import { ActionError, foregroundWindow, raise, tick, zOrder } from "./gui-state.js";

export const OVERLAY_MSG = "Сейчас идёт рисование: на экране вуаль режима выделения, ввод занят владельцем. Дождись исхода (screen_selection{op:start, waitMs}) или спроси владельца; ничего не нажато.";

/** Вуаль режима выделения: физический ввод отклоняется overlay_drawing — состояние системы, не провал модели. */
export function veilGate(ctx: Ctx, extra = ""): void {
  if (ctx.st.drawing) throw new ActionError(extra ? `${OVERLAY_MSG} ${extra}` : OVERLAY_MSG, "overlay_drawing");
}

export function inputWindow(ctx: Ctx): DesktopWindow {
  const w = foregroundWindow(ctx.core);
  if (!w) throw new ActionError("нет окна в фокусе — ввод некуда (передний план пуст): сфокусируй окно (window_focus / app_launch) и повтори; ничего не набрано", "runtime");
  return w;
}

/** Факты о поле с фокусом окна (для суда Space/Enter и вопроса «что уйдёт»). */
export function focusFacts(ctx: Ctx, w: DesktopWindow): { focused?: { role: string; name: string }; pending?: string } {
  const m = ctx.model(w);
  const id = m.focusId();
  const n = id ? m.nodes().find((x) => x.id === id) : undefined;
  return n ? { focused: { role: n.role, name: n.name }, ...(n.value ? { pending: n.value } : {}) } : {};
}

export function typeText(ctx: Ctx, text: string, scope: Scope): { w: DesktopWindow; accepted: boolean } {
  veilGate(ctx);
  const w = inputWindow(ctx);
  const { pending } = focusFacts(ctx, w);
  const fact: Fact = { op: "type", params: { text }, w, ...(pending ? { pending } : {}) };
  judge(scope, [fact]);
  const accepted = ctx.model(w).type(text);
  ctx.core.effect("input.type", { hwnd: w.hwnd, process: w.process, text, accepted });
  tick(ctx.core, 30 + text.length * 8);
  return { w, accepted };
}

export class BlockedKeyError extends ActionError {
  constructor(combo: string) {
    super(
      `комбинация «${combo}» запрещена (закрывает/блокирует окно или систему — может задеть Джарвис). Чтобы ЗАКРЫТЬ приложение, используй инструмент app_close (по процессу), а НЕ Alt+F4.`,
      "runtime",
    );
  }
}

const keysOf = (combo: string): string[] => {
  const n = normalizeCombo(combo);
  return n ? n.split("+") : [];
};

export function pressKey(ctx: Ctx, combo: string, mode: "press" | "down" | "up" | undefined, scope: Scope): { w?: DesktopWindow; accepted: boolean } {
  const { core, st } = ctx;
  const m = mode ?? "press";
  if (isBlockedCombo(combo)) throw new BlockedKeyError(combo);
  const keys = keysOf(combo);
  // Удерживаемые модификаторы живут между вызовами: Alt(down)+F4(press) — это Alt+F4 (блок-лист смотрит на итог).
  if (m !== "up" && st.held.size > 0 && isBlockedCombo([...st.held, ...keys].join("+"))) throw new BlockedKeyError([...st.held, ...keys].join("+"));
  if (m !== "up") veilGate(ctx);
  const w = inputWindow(ctx);
  if (m === "up") {
    for (const k of keys) st.held.delete(k);
    core.effect("input.key", { hwnd: w.hwnd, process: w.process, combo, mode: m, accepted: true });
    return { w, accepted: true };
  }
  const { focused, pending } = focusFacts(ctx, w);
  judge(scope, [{ op: "key", params: { combo, mode: m }, w, ...(focused ? { focused } : {}), ...(pending ? { pending } : {}) }]);
  if (m === "down") for (const k of keys) st.held.add(k);
  let accepted: boolean;
  if (/^alt\+tab$/iu.test(normalizeCombo(combo))) {
    const next = zOrder(core, st).filter((x) => !x.minimized)[1];
    if (next) raise(core, st, next);
    accepted = Boolean(next);
  } else accepted = m === "press" ? ctx.model(w).key(combo) : false;
  core.effect("input.key", { hwnd: w.hwnd, process: w.process, combo, mode: m, accepted });
  tick(core, 40);
  return { w, accepted };
}

/**
 * Универсальный диалог («Сохранить как», «Сохранить изменения?»): подписи, необязательное поле и кнопки. Модальность:
 * пока диалог открыт, владелец-окно живёт своей жизнью (в лаборатории это не блокирует ввод — достаточно для сценариев).
 */
import type { DesktopWindow } from "../lib/contracts.js";
import type { Ctx, Model, NodeSpec } from "./gui-model.js";
import { at, parseCombo } from "./gui-model.js";
import { ActionError, dropWindow } from "./gui-state.js";

export interface DialogButton {
  name: string;
  /** Вернуть false, чтобы диалог остался (например, пустое имя файла). */
  run: (fieldValue: string) => boolean | undefined;
}

export interface DialogSpec {
  lines: string[];
  field?: { name: string; automationId: string; value: string };
  /** Первая — кнопка по умолчанию (Enter), последняя — отмена (Esc). */
  buttons: DialogButton[];
}

export function dialogModel(ctx: Ctx, w: DesktopWindow, spec: DialogSpec): Model {
  let value = spec.field?.value ?? "";
  let focus: string | null = spec.field ? "field" : null;
  const closeSelf = (): void => {
    dropWindow(ctx.core, ctx.st, w);
    ctx.core.effect("window.close", { hwnd: w.hwnd, pid: w.pid, process: w.process, via: "dialog", force: false });
  };
  const runButton = (i: number): void => {
    const b = spec.buttons[i];
    if (!b) return;
    if (b.run(value) !== false) closeSelf();
  };
  const sync = (): void => {
    w.text = value;
  };
  return {
    kind: "dialog",
    nodes(): NodeSpec[] {
      const out: NodeSpec[] = spec.lines.map((l, i) => ({ id: `line:${i}`, role: "text", name: l, ...at(w, 20, 10 + i * 22, w.rect.w - 40, 20), interactive: false }));
      const fy = 10 + spec.lines.length * 22 + 8;
      if (spec.field) out.push({ id: "field", role: "edit", name: spec.field.name, automationId: spec.field.automationId, value, ...at(w, 20, fy, w.rect.w - 40, 26), interactive: true });
      spec.buttons.forEach((b, i) => out.push({ id: `btn:${i}`, role: "button", name: b.name, ...at(w, 20 + i * 110, w.rect.h - 32 - 44, 100, 30), interactive: true }));
      return out;
    },
    focusId: () => focus,
    press(id) {
      if (id.startsWith("btn:")) return runButton(Number(id.slice(4)));
      if (id === "field") focus = "field";
    },
    setValue(id, v) {
      if (id !== "field") throw new ActionError("ValuePattern не поддержан этим элементом", "runtime");
      value = v;
      sync();
    },
    type(text) {
      if (focus !== "field") return false;
      value += text.replace(/\r?\n/gu, "");
      sync();
      return true;
    },
    key(combo) {
      const k = parseCombo(combo);
      if (k.key === "enter") return (runButton(0), true);
      if (k.key === "escape") return (runButton(spec.buttons.length - 1), true);
      if (focus === "field" && k.key === "backspace") return ((value = value.slice(0, -1)), sync(), true);
      return false;
    },
    focus(id) {
      if (id === "field") focus = "field";
    },
    selectedText: () => "",
  };
}

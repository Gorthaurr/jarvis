/**
 * Универсальное окно (steam, obs, code, word, …): заголовок и панель — и всё. Ввод «в никуда» не принимается
 * (type/key вернут false → эффект с accepted:false), кнопки заголовка (свернуть/закрыть) добавляет общий слой gui-tree.
 */
import type { DesktopWindow } from "../lib/contracts.js";
import type { Model, NodeSpec } from "./gui-model.js";
import { at } from "./gui-model.js";
import { ActionError } from "./gui-state.js";

export function genericModel(w: DesktopWindow): Model {
  return {
    kind: "generic",
    nodes: (): NodeSpec[] => [{ id: "pane", role: "pane", name: w.title, ...at(w, 0, 0, w.rect.w, w.rect.h - 32), interactive: false }],
    focusId: () => null,
    press() {},
    setValue() {
      throw new ActionError("ValuePattern не поддержан этим элементом", "runtime");
    },
    type: () => false,
    key: () => false,
    focus() {},
    selectedText: () => "",
  };
}

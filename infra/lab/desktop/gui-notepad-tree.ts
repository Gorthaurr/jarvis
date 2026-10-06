import type { DesktopWindow } from "../lib/contracts.js";
import { at, type NodeSpec } from "./gui-model.js";
export const FILE_MENU = ["Создать", "Открыть...", "Сохранить", "Сохранить как...", "Выход"];
export const EDIT_MENU = ["Вырезать", "Копировать", "Вставить", "Выделить все"];

export function notepadNodes(w: DesktopWindow, menu: "file" | "edit" | null): NodeSpec[] {
  const lines = w.text.split("\n");
  const pos = `Стр ${lines.length}, стлб ${(lines[lines.length - 1] ?? "").length + 1}`;
  const out: NodeSpec[] = ["Файл", "Правка", "Формат", "Вид", "Справка"].map((n, i) => ({ id: `menu:${n}`, role: "menuitem", name: n, ...at(w, i * 64, 0, 64, 24), interactive: true }));
  out.push({ id: "edit", role: "edit", name: "Текстовый редактор", automationId: "15", value: w.text, ...at(w, 0, 24, w.rect.w, w.rect.h - 32 - 24 - 22), interactive: true });
  out.push({ id: "status", role: "text", name: "Строка состояния", value: pos, label: pos, ...at(w, 0, w.rect.h - 32 - 22, w.rect.w, 22), interactive: false });
  const items = menu === "file" ? FILE_MENU : menu === "edit" ? EDIT_MENU : [];
  items.forEach((n, i) => out.push({ id: `item:${n}`, role: "menuitem", name: n, ...at(w, menu === "edit" ? 64 : 0, 24 + i * 24, 180, 24), interactive: true }));
  return out;
}

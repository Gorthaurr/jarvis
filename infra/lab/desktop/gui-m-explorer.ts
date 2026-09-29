/**
 * Проводник: каталог виртуальной ФС ядра (только чтение состояния оттуда), навигация, выбор, открытие файла в
 * приложении, Delete (в корзину = удаление из ФС песочницы). `window.text` — имена элементов построчно.
 */
import type { DesktopWindow } from "../lib/contracts.js";
import { normPath } from "./core.js";
import type { Ctx, Model, NodeSpec } from "./gui-model.js";
import { at, parseCombo } from "./gui-model.js";
import { ActionError } from "./gui-state.js";

const NAMES: Record<string, string> = { Desktop: "Рабочий стол", Documents: "Документы", Downloads: "Загрузки" };
const parent = (p: string): string => p.slice(0, p.lastIndexOf("/")) || p;
const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const win = (p: string): string => p.replace(/\//gu, "\\");

export function explorerTitle(path: string, home: string): string {
  if (/^[A-Z]:$/u.test(path)) return `Локальный диск (${path})`;
  if (path === home) return base(home);
  return parent(path) === home ? (NAMES[base(path)] ?? base(path)) : base(path);
}

export function explorerModel(ctx: Ctx, w: DesktopWindow, startPath?: string): Model {
  const { core } = ctx;
  let path = normPath(startPath ?? `${core.fs.home}/Desktop`);
  const back: string[] = [];
  let selected: string | null = null;
  let addrFocus = false;
  let addrText = "";

  const entries = (): Array<{ name: string; dir: boolean; full: string }> => {
    const dirs = [...core.fs.dirs].filter((d) => d !== path && parent(d) === path).map((d) => ({ name: base(d), dir: true, full: d }));
    const files = [...core.fs.files.keys()].filter((f) => parent(f) === path).map((f) => ({ name: base(f), dir: false, full: f }));
    const by = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, "ru", { sensitivity: "base" });
    return [...dirs.sort(by), ...files.sort(by)].slice(0, 80);
  };
  const syncText = (): void => {
    w.text = entries().map((e) => e.name).join("\n");
  };
  const sync = (): void => {
    w.title = explorerTitle(path, core.fs.home);
    syncText();
  };
  const go = (to: string, push = true): void => {
    if (push) back.push(path);
    path = to;
    selected = null;
    addrFocus = false;
    sync();
    core.effect("explorer.navigate", { hwnd: w.hwnd, path });
  };
  const open = (full: string, dir: boolean): void => {
    if (dir) return go(full);
    try {
      ctx.open("file", full);
    } catch {
      core.effect("explorer.open.failed", { path: full, reason: "нет приложения для файла" });
    }
  };
  const openSelected = (): void => {
    const e = entries().find((x) => x.full === selected);
    if (e) open(e.full, e.dir);
  };
  const submitAddress = (): void => {
    const p = normPath(addrText.trim());
    if (core.fs.dirs.has(p)) go(p);
    else {
      addrFocus = false;
      core.effect("explorer.navigate.failed", { hwnd: w.hwnd, path: p });
    }
  };

  const m: Model = {
    kind: "explorer",
    nodes(): NodeSpec[] {
      const out: NodeSpec[] = [
        { id: "back", role: "button", name: "Назад", label: "", ...at(w, 4, 4, 28, 28), interactive: true },
        { id: "up", role: "button", name: "Вверх на один уровень", label: "", ...at(w, 36, 4, 28, 28), interactive: true },
        { id: "addr", role: "edit", name: "Адресная строка", automationId: "1001", value: addrFocus ? addrText : win(path), ...at(w, 72, 4, w.rect.w - 80, 28), interactive: true },
        { id: "list", role: "list", name: "Элементы вида", ...at(w, 0, 40, w.rect.w, w.rect.h - 32 - 40), interactive: false },
      ];
      entries().forEach((e, i) => out.push({ id: `item:${e.full}`, role: "listitem", name: e.name, ...at(w, 8, 44 + i * 22, Math.min(360, w.rect.w - 16), 22), interactive: true }));
      return out;
    },
    focusId: () => (addrFocus ? "addr" : selected ? `item:${selected}` : "list"),
    press(id, o) {
      if (id === "back") return void (back.length && go(back.pop()!, false));
      if (id === "up") return go(parent(path));
      if (id === "addr") return m.focus(id);
      if (id.startsWith("item:")) {
        selected = id.slice(5);
        addrFocus = false;
        if (o.invoke || o.count >= 2) openSelected();
        else core.effect("explorer.select", { hwnd: w.hwnd, path: selected });
      }
    },
    setValue(id, v) {
      if (id !== "addr") throw new ActionError("ValuePattern не поддержан этим элементом", "runtime");
      addrText = v;
      submitAddress();
    },
    type(text) {
      if (addrFocus) {
        addrText += text.replace(/\r?\n/gu, "");
        if (/\n/u.test(text)) submitAddress();
        return true;
      }
      const hit = entries().find((e) => e.name.toLowerCase().startsWith(text.trim().toLowerCase()));
      if (hit && text.trim()) selected = hit.full;
      return true;
    },
    key(combo) {
      const k = parseCombo(combo);
      if ((k.ctrl && k.key === "l") || k.key === "f4" || (k.alt && k.key === "d")) return ((addrFocus = true), (addrText = win(path)), true);
      if (k.key === "enter") return (addrFocus ? submitAddress() : openSelected(), true);
      if ((k.alt && k.key === "arrowleft") || k.key === "backspace") return (back.length && go(back.pop()!, false), true);
      if (k.alt && k.key === "arrowup") return (go(parent(path)), true);
      if (k.key === "delete" && selected && core.fs.files.has(selected)) {
        core.fs.files.delete(selected);
        core.effect("fs.delete", { path: selected, via: "explorer", recycle: true });
        selected = null;
        return (sync(), true);
      }
      if (k.ctrl && k.key === "a") return true;
      return false;
    },
    focus(id) {
      addrFocus = id === "addr";
      if (addrFocus) addrText = win(path);
    },
    selectedText: () => (selected ? base(selected) : ""),
  };
  syncText(); // заголовок не трогаем: seed-окно уже названо, а новое окно назвал реестр приложений
  return m;
}

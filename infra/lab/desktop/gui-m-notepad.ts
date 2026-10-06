import { notepadNodes } from "./gui-notepad-tree.js";
/**
 * Блокнот: Edit-контрол с текстом (он же `window.text`), меню «Файл»/«Правка», сохранение в виртуальную ФС через диалог,
 * вопрос «Сохранить изменения?» при закрытии несохранённого (app.close честно вернёт «не закрыто»).
 */
import type { DesktopWindow } from "../lib/contracts.js";
import { normPath } from "./core.js";
import { dialogModel } from "./gui-m-dialog.js";
import type { Ctx, Model } from "./gui-model.js";
import { parseCombo } from "./gui-model.js";
import { ActionError } from "./gui-state.js";
import { closeWin } from "./gui-winops.js";

const SUFFIX = / [—-] Блокнот$/u;

export function notepadModel(ctx: Ctx, w: DesktopWindow, opts: { path?: string } = {}): Model {
  const { core } = ctx;
  let path: string | null = opts.path ? normPath(opts.path) : null;
  let saved = w.text;
  let selAll = false;
  let menu: "file" | "edit" | null = null;
  const baseName = (): string => (path ? path.slice(path.lastIndexOf("/") + 1) : w.title.replace(/^\*/u, "").replace(SUFFIX, "") || "Безымянный");
  const modified = (): boolean => w.text !== saved;
  const sync = (): void => {
    w.title = `${modified() ? "*" : ""}${baseName()} — Блокнот`;
  };
  const setText = (t: string): void => {
    w.text = t;
    selAll = false;
    sync();
  };
  const write = (p: string): void => {
    core.fs.files.set(p, Buffer.from(w.text, "utf8"));
    for (let d = p.slice(0, p.lastIndexOf("/")); d.length > 2; d = d.slice(0, d.lastIndexOf("/"))) core.fs.dirs.add(d);
    path = p;
    saved = w.text;
    sync();
    core.effect("fs.write", { path: p, bytes: Buffer.byteLength(w.text, "utf8"), via: "notepad" });
  };
  const askSaveAs = (then?: () => void): void => {
    const dlg = ctx.spawn({
      process: "notepad",
      pid: w.pid,
      title: "Сохранение",
      rect: { x: w.rect.x + 80, y: w.rect.y + 60, w: 520, h: 220 },
      monitor: w.monitor,
      model: (dw) =>
        dialogModel(ctx, dw, {
          lines: ["Сохранить как"],
          field: { name: "Имя файла:", automationId: "1001", value: baseName() === "Безымянный" ? "" : baseName() },
          buttons: [
            {
              name: "Сохранить",
              run: (v) => {
                const name = v.trim();
                if (!name) return false;
                const abs = /^[A-Za-z]:|^\//u.test(name) ? name : `${core.fs.home}/Documents/${name}`;
                write(normPath(/\.[^/.]+$/u.test(abs) ? abs : `${abs}.txt`));
                then?.();
                return true;
              },
            },
            { name: "Отмена", run: () => true },
          ],
        }),
    });
    void dlg;
  };
  const save = (): void => (path ? write(path) : askSaveAs());
  const menuRun = (label: string): void => {
    menu = null;
    if (label === "Создать") return setText("");
    if (label === "Сохранить") return save();
    if (label === "Сохранить как...") return askSaveAs();
    if (label === "Выход") return void closeWin(ctx, w, false, "menu");
    if (label === "Выделить все") selAll = true;
    else if (label === "Копировать" || label === "Вырезать") copy(label === "Вырезать");
    else if (label === "Вставить") setText(selAll ? core.clipboard : w.text + core.clipboard);
  };
  const copy = (cut: boolean): void => {
    if (!selAll || !w.text) return;
    core.clipboard = w.text;
    core.effect("clipboard.write", { text: w.text, via: "notepad" });
    if (cut) setText("");
  };

  const m: Model = {
    kind: "notepad",
    nodes: () => notepadNodes(w, menu),
    focusId: () => "edit",
    press(id) {
      if (id.startsWith("item:")) return menuRun(id.slice(5));
      if (id === "menu:Файл") menu = menu === "file" ? null : "file";
      else if (id === "menu:Правка") menu = menu === "edit" ? null : "edit";
      else menu = null;
    },
    setValue(id, v) {
      if (id !== "edit") throw new ActionError("ValuePattern не поддержан этим элементом", "runtime");
      setText(v);
    },
    type(text) {
      menu = null;
      const t = text.replace(/\r\n/gu, "\n");
      setText(selAll ? t : w.text + t);
      return true;
    },
    key(combo) {
      const k = parseCombo(combo);
      if (k.ctrl && k.key === "a") return ((selAll = true), true);
      if (k.ctrl && (k.key === "c" || k.key === "x")) return (copy(k.key === "x"), true);
      if (k.ctrl && k.key === "v") return (setText(selAll ? core.clipboard : w.text + core.clipboard), true);
      if (k.ctrl && k.key === "s") return (save(), true);
      if (k.ctrl && k.key === "n") return (setText(""), true);
      if (k.key === "enter" && !k.ctrl && !k.alt) return (setText(selAll ? "\n" : `${w.text}\n`), true);
      if (k.key === "backspace") return (setText(selAll ? "" : w.text.slice(0, -1)), true);
      if (k.key === "delete") return (selAll && setText(""), true);
      if (k.key === "tab") return (setText(`${w.text}\t`), true);
      if (k.key === "escape") return ((menu = null), true);
      return false;
    },
    focus() {
      menu = null;
    },
    selectedText: () => (selAll ? w.text : ""),
    canClose() {
      if (!modified() || w.text === "") return true;
      // Как настоящий Блокнот: закрытие несохранённого спрашивает; окно остаётся, пока пользователь не ответит.
      ctx.spawn({
        process: "notepad",
        pid: w.pid,
        title: "Блокнот",
        rect: { x: w.rect.x + 100, y: w.rect.y + 80, w: 480, h: 180 },
        monitor: w.monitor,
        model: (dw) =>
          dialogModel(ctx, dw, {
            lines: [`Вы хотите сохранить изменения в файле «${baseName()}»?`],
            buttons: [
              { name: "Сохранить", run: () => (path ? (write(path), void closeWin(ctx, w, true, "dialog"), true) : (askSaveAs(() => void closeWin(ctx, w, true, "dialog")), true)) },
              { name: "Не сохранять", run: () => (void closeWin(ctx, w, true, "dialog"), true) },
              { name: "Отмена", run: () => true },
            ],
          }),
      });
      return false;
    },
  };
  sync();
  return m;
}

/**
 * Мессенджер (telegram/discord/whatsapp/…): список чатов, история, поле ввода и кнопка «Отправить». Отправка — ЭФФЕКТ
 * `app.message.sent {process, chat, text, via}` в журнале: по нему eval проверяет, ушло ли сообщение на самом деле.
 * Рубеж §14 судит Enter/«Отправить» ДО модели (gui-guard) — сюда доходит только одобренное или безобидное.
 */
import type { DesktopWindow } from "../lib/contracts.js";
import type { Ctx, Model, NodeSpec } from "./gui-model.js";
import { at, parseCombo } from "./gui-model.js";
import { ActionError } from "./gui-state.js";

interface Msg {
  dir: "in" | "out";
  text: string;
}
interface Chat {
  name: string;
  msgs: Msg[];
}

const SEED: Chat[] = [
  { name: "Избранное", msgs: [] },
  { name: "Катя", msgs: [{ dir: "in", text: "Привет! Ты завтра придёшь?" }] },
  { name: "Работа", msgs: [{ dir: "in", text: "Отчёт готов?" }] },
];
const LABEL = (p: string): string => p.replace(/\.exe$/iu, "").replace(/^./u, (c) => c.toUpperCase());

export function messengerModel(ctx: Ctx, w: DesktopWindow): Model {
  const chats: Chat[] = SEED.map((c) => ({ name: c.name, msgs: [...c.msgs] }));
  const brand = LABEL(w.process);
  const seedChat = w.title.replace(new RegExp(`\\s[—-]\\s*${brand}$`, "iu"), "").trim();
  let active = Math.max(0, chats.findIndex((c) => c.name === seedChat));
  if (seedChat && !chats.some((c) => c.name === seedChat)) {
    chats.push({ name: seedChat, msgs: [] });
    active = chats.length - 1;
  }
  let draft = "";
  let search = "";
  let focus: "msg" | "search" = "msg";
  const chat = (): Chat => chats[active]!;
  const sync = (): void => {
    w.text = chat().msgs.map((m) => m.text).join("\n");
  };
  const send = (via: string): void => {
    const text = draft.trim();
    if (!text) return;
    chat().msgs.push({ dir: "out", text });
    draft = "";
    ctx.core.effect("app.message.sent", { hwnd: w.hwnd, process: w.process, chat: chat().name, text, via });
    sync();
  };
  const select = (i: number): void => {
    active = i;
    focus = "msg";
    w.title = `${chat().name} — ${brand}`;
    sync();
  };

  const m: Model = {
    kind: "messenger",
    nodes(): NodeSpec[] {
      const out: NodeSpec[] = [{ id: "search", role: "edit", name: "Поиск", automationId: "SearchInput", value: search, ...at(w, 8, 6, 264, 28), interactive: true }];
      chats.forEach((c, i) => out.push({ id: `chat:${i}`, role: "listitem", name: c.name, ...at(w, 0, 44 + i * 56, 280, 56), interactive: true }));
      out.push({ id: "title", role: "text", name: chat().name, ...at(w, 290, 6, 400, 28), interactive: false });
      chat().msgs.slice(-8).forEach((x, i) => out.push({ id: `msg:${i}`, role: "text", name: x.text, ...at(w, 290 + (x.dir === "out" ? 200 : 0), 50 + i * 40, 380, 32), interactive: false }));
      out.push({ id: "input", role: "edit", name: "Написать сообщение...", automationId: "MessageInput", value: draft, ...at(w, 290, w.rect.h - 32 - 52, w.rect.w - 290 - 130, 40), interactive: true });
      out.push({ id: "attach", role: "button", name: "Прикрепить файл", label: "", ...at(w, w.rect.w - 120, w.rect.h - 32 - 52, 36, 40), interactive: true });
      out.push({ id: "send", role: "button", name: "Отправить", automationId: "SendButton", label: "➤", ...at(w, w.rect.w - 78, w.rect.h - 32 - 52, 70, 40), interactive: true });
      return out;
    },
    focusId: () => (focus === "search" ? "search" : "input"),
    press(id) {
      if (id.startsWith("chat:")) return select(Number(id.slice(5)));
      if (id === "send") return send("button");
      if (id === "search" || id === "input") m.focus(id);
    },
    setValue(id, v) {
      if (id === "input") draft = v;
      else if (id === "search") search = v;
      else throw new ActionError("ValuePattern не поддержан этим элементом", "runtime");
    },
    type(text) {
      const parts = text.replace(/\r\n/gu, "\n").split("\n");
      parts.forEach((p, i) => {
        if (focus === "search") search += p;
        else draft += p;
        if (i < parts.length - 1 && focus === "msg") send("enter"); // «\n» при печати = Enter
      });
      return true;
    },
    key(combo) {
      const k = parseCombo(combo);
      if (k.key === "enter") return (focus === "msg" && (k.shift ? (draft += "\n") : send("enter")), true);
      if (k.key === "backspace") return ((focus === "msg" ? (draft = draft.slice(0, -1)) : (search = search.slice(0, -1))), true);
      if (k.ctrl && k.key === "v") return ((focus === "msg" ? (draft += ctx.core.clipboard) : (search += ctx.core.clipboard)), true);
      if (k.ctrl && k.key === "f") return ((focus = "search"), true);
      if (k.key === "escape") return ((search = ""), (focus = "msg"), true);
      return false;
    },
    focus(id) {
      focus = id === "search" ? "search" : "msg";
    },
    selectedText: () => "",
  };
  sync();
  return m;
}

/** Черновик — для вопроса §14 «что уйдёт»: рубеж читает его как pendingText. */
export const draftOf = (m: Model): string => (m.nodes().find((n) => n.id === "input")?.value ?? "");

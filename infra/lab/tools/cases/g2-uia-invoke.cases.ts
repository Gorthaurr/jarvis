/**
 * G2: ui_invoke — UIA-паттерн без курсора. Главное: «Отправить» в мессенджере без «да» владельца не нажимается (три
 * разных исхода вопроса), пароль через setValue не вводится (§0), рубеж не даёт нажать кнопки окна самого Джарвиса,
 * провал клиента виден (нет ложного успеха). Два пути §14: спрашивает СЕРВЕР до отправки (знает программу) или КЛИЕНТ.
 */
import type { ToolCase } from "../case-format.js";
import { JARVIS, NOTEPAD, TG, withSys } from "./g2-fixtures.js";

const INPUT = { by: "role", role: "edit", name: "Написать сообщение..." };
const SEND = { by: "role", role: "button", name: "Отправить" };
const draft = { tool: "ui_invoke", args: { target: INPUT, pattern: "setValue", value: "привет" } };
const sentNothing = [{ none: "app.message.sent" }, { none: "ui.invoke" }];

export const cases: ToolCase[] = [
  {
    tool: "ui_invoke", name: "setValue кладёт текст в поле, но НЕ отправляет его (эффект setValue, сообщения нет)", args: { target: INPUT, pattern: "setValue", value: "привет" }, seed: TG,
    expect: { ok: true, asked: 0, actionKinds: ["ui.invoke"], flags: { observed: true }, effects: [{ has: "ui.invoke", detail: { pattern: "setValue", value: "привет" } }, { none: "app.message.sent" }], resultIncludes: "Edit: Написать сообщение... [привет]" },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "«Отправить» без «да»: владелец сказал нет — клиент отказал, сообщение не ушло", before: [draft], args: { target: SEND, pattern: "invoke" }, seed: TG, confirm: "no",
    expect: { ok: true, asked: 1, actionKinds: ["ui.invoke"], flags: { declined: true }, effects: sentNothing, resultIncludes: /Отменено пользователем/ },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "«Отправить» + «да»: одно «да» = одно нажатие, сообщение ушло с нужным текстом", before: [draft], args: { target: SEND, pattern: "invoke" }, seed: TG, confirm: "yes",
    expect: { ok: true, asked: 1, actionKinds: ["ui.invoke", "ui.invoke"], flags: { declined: false }, effects: [{ has: "app.message.sent", detail: { chat: "Избранное", text: "привет", via: "button" }, count: 1 }] },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "вопрос истёк — не приписываем владельцу ни «да», ни «нет»", before: [draft], args: { target: SEND, pattern: "invoke" }, seed: TG, confirm: "expire",
    expect: { asked: 1, flags: { declined: true, channelDown: false }, effects: sentNothing, resultIncludes: /не ответили|истекло/, resultExcludes: /Отменено пользователем/ },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "вопрос не дошёл (канал мёртв) — «не смог спросить» + channelDown, а не «вы отказали»", before: [draft], args: { target: SEND, pattern: "invoke" }, seed: TG, confirm: "undelivered",
    expect: { asked: 1, flags: { declined: true, channelDown: true }, effects: sentNothing, resultIncludes: /не смог спросить/, resultExcludes: /Отменено пользователем/ },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "сервер знает имя из снимка (handle) и программу (systemContext) — спрашивает ДО отправки: «нет» → клиенту не ушло ничего",
    before: [draft, { tool: "ui_snapshot" }], args: { target: { by: "handle", handle: "100200008" }, pattern: "invoke" }, seed: TG, confirm: "no", lab: { ctx: withSys() },
    expect: { asked: 1, actionKinds: [], flags: { declined: true }, resultIncludes: /клик «Отправить»/, effects: sentNothing },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "тот же путь, «да»: выдан грант заранее — команда уходит клиенту ОДИН раз, сообщение отправлено",
    before: [draft, { tool: "ui_snapshot" }], args: { target: { by: "handle", handle: "100200008" }, pattern: "invoke" }, seed: TG, confirm: "yes", lab: { ctx: withSys() },
    expect: { asked: 1, actionKinds: ["ui.invoke"], effects: [{ has: "app.message.sent", detail: { text: "привет" }, count: 1 }] },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "§0: setValue в поле «Пароль» отклонён сервером — клиенту ничего не ушло, владелец не спрошен", args: { target: { by: "role", role: "edit", name: "Пароль" }, pattern: "setValue", value: "hunter2" }, seed: TG,
    expect: { ok: false, asked: 0, actionKinds: [], resultIncludes: /Пароли и коды подтверждения не ввожу/, effects: [{ none: "ui.invoke" }] },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "setValue без значения — ошибка, а не молчаливая очистка поля", args: { target: INPUT, pattern: "setValue" }, seed: TG,
    expect: { ok: false, actionKinds: ["ui.invoke"], resultIncludes: /setValue без значения/, effects: [{ none: "ui.invoke" }] },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "элемента нет / handle устарел — честная ошибка с подсказкой про зрение", args: { target: { by: "handle", handle: "424242" }, pattern: "invoke" }, seed: TG,
    expect: { ok: false, actionKinds: ["ui.invoke"], resultIncludes: [/не найден \(окно закрыто или элемент исчез\)/, /screen_capture/], effects: [{ none: "ui.invoke" }] },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "по координатам UIA-паттерн невозможен — ошибка, ничего не нажато", args: { target: { by: "coords", x: 10, y: 10 }, pattern: "invoke" }, seed: TG,
    expect: { ok: false, actionKinds: ["ui.invoke"], resultIncludes: /по координатам невозможен/, effects: [{ none: "ui.invoke" }, { none: "input.click" }] },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "непаттернуемый элемент (строка состояния Блокнота — текст): «паттерн не поддержан», а не «нажато»", args: { target: { by: "role", role: "text", name: "Строка состояния" }, pattern: "invoke" }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: ["ui.invoke"], resultIncludes: /паттерн invoke не поддержан/, effects: [{ none: "ui.invoke" }] },
    coversTool: "ui_invoke",
  },
  {
    tool: "ui_invoke", name: "рубеж «self»: кнопка «Закрыть» окна самого Джарвиса не нажимается — без вопроса, окно на месте", args: { target: { by: "role", role: "button", name: "Закрыть" }, pattern: "invoke" }, seed: JARVIS, confirm: "yes",
    expect: {
      ok: false, asked: 0, actionKinds: ["ui.invoke"], resultIncludes: /самого Джарвиса/, effects: [{ none: "window.close" }],
      state: (s) => s.windows.some((w) => w.process === "electron") || "окно Джарвиса закрыто",
    },
    coversTool: "ui_invoke",
  },
];

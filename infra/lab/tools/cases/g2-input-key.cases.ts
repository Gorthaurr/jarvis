/**
 * G2: input_key — клавиша/сочетание/удержание. Блок-лист комбо (Alt+F4, Win+L) стоит ВЫШЕ вуали и держится по итогу
 * удержанных клавиш; Enter/Ctrl+Enter в мессенджере, банке, 1С и удалённом доступе — вопрос §14 (три разных исхода);
 * вставка судится по содержимому буфера (карта из буфера не вставляется). `mode:"up"` вуалью не гейтится.
 */
import type { DesktopSnapshot } from "../../lib/contracts.js";
import type { ToolCase } from "../case-format.js";
import { BANK, JARVIS, NOTEPAD, ONEC, TG, echoSession, withSys } from "./g2-fixtures.js";

const ANYDESK = { windows: [{ title: "AnyDesk — сервер", process: "anydesk" }] };
const draft = [{ tool: "input_type", args: { text: "привет" } }];
const ENTER = { combo: "Enter" };
const notSent = [{ none: "app.message.sent" }, { none: "input.key" }];
const alive = (s: DesktopSnapshot): boolean | string => s.windows.some((w) => w.process === "notepad") || "окно Блокнота закрыто";

export const cases: ToolCase[] = [
  {
    tool: "input_key", name: "Ctrl+S в Блокноте: реально появилось окно «Сохранение» (а не только ok)", args: { combo: "Ctrl+S" }, seed: NOTEPAD,
    expect: { ok: true, actionKinds: ["input.key"], effects: [{ has: "input.key", detail: { combo: "Ctrl+S", accepted: true } }], state: (s) => s.windows.some((w) => w.title === "Сохранение") || `окна: ${s.windows.map((w) => w.title).join(" | ")}` },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "Ctrl+V вставляет то, что Джарвис положил в буфер: текст оказался в окне", before: [{ tool: "system_clipboard", args: { op: "write", text: "привет" } }], args: { combo: "Ctrl+V" }, seed: NOTEPAD,
    expect: { ok: true, actionKinds: ["input.key"], state: (s) => s.windows.find((w) => w.process === "notepad")?.text === "привет" || "текст не вставился" },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "Alt+F4 запрещён: ошибка с подсказкой про app_close, окно на месте", args: { combo: "Alt+F4" }, seed: NOTEPAD, confirm: "yes",
    expect: { ok: false, asked: 0, resultIncludes: [/запрещена/, /app_close/], effects: [{ none: "input.key" }, { none: "window.close" }], state: alive },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "удержанный Alt + F4 = Alt+F4: блок по итогу удержания, окно на месте", before: [{ tool: "input_key", args: { combo: "Alt", mode: "down" } }], args: { combo: "F4" }, seed: NOTEPAD,
    expect: { ok: false, resultIncludes: /alt\+f4.*запрещена/, effects: [{ none: "window.close" }], state: alive },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "Win+L запрещён (блокировка — только system_lock): сессия не заблокирована", args: { combo: "Win+L" }, seed: NOTEPAD,
    expect: { ok: false, resultIncludes: /запрещена/, state: (s) => !s.locked || "сессия заблокирована" },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "Enter в мессенджере, владелец «нет»: сообщение не ушло", before: draft, args: ENTER, seed: TG, confirm: "no",
    expect: { asked: 1, actionKinds: ["input.key"], flags: { declined: true }, effects: notSent, resultIncludes: /Отменено пользователем/ },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "Enter в мессенджере, «да»: ушло ровно одно сообщение с набранным текстом", before: draft, args: ENTER, seed: TG, confirm: "yes",
    expect: { ok: true, asked: 1, actionKinds: ["input.key", "input.key"], effects: [{ has: "app.message.sent", detail: { text: "привет", via: "enter" }, count: 1 }] },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "Enter: вопрос истёк — «не ответили», сообщение не ушло", before: draft, args: ENTER, seed: TG, confirm: "expire",
    expect: { asked: 1, flags: { declined: true, channelDown: false }, effects: notSent, resultIncludes: /не ответили|истекло/, resultExcludes: /Отменено пользователем/ },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "Enter: вопрос не доставлен — «не смог спросить» + channelDown, не «вы отказали»", before: draft, args: ENTER, seed: TG, confirm: "undelivered",
    expect: { asked: 1, flags: { declined: true, channelDown: true }, effects: notSent, resultIncludes: /не смог спросить/, resultExcludes: /Отменено пользователем/ },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "сервер знает программу (systemContext): спрашивает до отправки — «нет» → клиенту ничего", before: draft, args: ENTER, seed: TG, confirm: "no", lab: { ctx: withSys() },
    expect: { asked: 1, actionKinds: [], flags: { declined: true }, effects: notSent },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "тот же путь, «да»: одна команда с заранее выданным грантом, сообщение ушло", before: draft, args: ENTER, seed: TG, confirm: "yes", lab: { ctx: withSys() },
    expect: { asked: 1, actionKinds: ["input.key"], effects: [{ has: "app.message.sent", detail: { text: "привет" }, count: 1 }] },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "1С: Enter («провести») — вопрос владельцу, отказ = клавиша не нажата", args: ENTER, seed: ONEC, confirm: "no",
    expect: { asked: 1, flags: { declined: true }, effects: [{ none: "input.key" }], resultIncludes: /1С/ },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "удалённый доступ: внутрь UIA не видит, поэтому судятся клавиши — Enter спрашивает владельца", args: ENTER, seed: ANYDESK, confirm: "no",
    expect: { asked: 1, flags: { declined: true }, effects: [{ none: "input.key" }], resultIncludes: /удалённый доступ/ },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "банк: Ctrl+Enter тоже коммит (любые модификаторы) — вопрос, отказ = не нажато", args: { combo: "Ctrl+Enter" }, seed: BANK, confirm: "no",
    expect: { asked: 1, flags: { declined: true }, effects: [{ none: "input.key" }], resultIncludes: /банк-клиент/ },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "§0: Ctrl+V с номером карты в буфере (владелец скопировал) отклонён сервером до отправки", before: [{ tool: "system_clipboard", args: { op: "read" } }], args: { combo: "Ctrl+V" },
    seed: { ...TG, clipboard: "4111 1111 1111 1111" },
    expect: { ok: false, asked: 0, actionKinds: [], resultIncludes: /платёжные реквизиты/, effects: [{ none: "input.key" }] },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "вуаль: Ctrl+A отклонён overlay_drawing — ничего не нажато", before: [{ tool: "screen_selection", args: { op: "start" } }], args: { combo: "Ctrl+A" }, seed: NOTEPAD,
    expect: { ok: false, flags: { overlayDenied: true }, resultIncludes: /вуаль/, effects: [{ none: "input.key" }] },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "вуаль: отпустить удержанную клавишу (mode:up) можно — иначе клавиша залипла бы", before: [{ tool: "screen_selection", args: { op: "start" } }], args: { combo: "W", mode: "up" }, seed: NOTEPAD,
    expect: { ok: true, flags: { overlayDenied: false }, actionKinds: ["input.key"], effects: [{ has: "input.key", detail: { combo: "W", mode: "up" } }] },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "удержание (mode:down): эффект есть, наблюдения «до/после» нет — середина жеста", args: { combo: "W", mode: "down" }, seed: NOTEPAD,
    expect: { ok: true, actionKinds: ["input.key"], effects: [{ has: "input.key", detail: { combo: "W", mode: "down" } }], resultExcludes: /ИЗМЕНЕНИЯ ЭКРАНА/ },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "рубеж «self»: клавиши в окно самого Джарвиса отклонены без вопроса", args: { combo: "Ctrl+A" }, seed: JARVIS, confirm: "yes",
    expect: { ok: false, asked: 0, resultIncludes: /самого Джарвиса/, effects: [{ none: "input.key" }] },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "нет окна в фокусе — ошибка, клавиша некуда", args: { combo: "Ctrl+A" },
    expect: { ok: false, actionKinds: ["input.key"], resultIncludes: /нет окна в фокусе/, effects: [{ none: "input.key" }] },
    coversTool: "input_key",
  },
  {
    tool: "input_key", name: "поля схемы доезжают клиенту (mode, scancode), а approval/origin модели срезаны — origin ставит сервер",
    args: { combo: "W", mode: "down", scancode: true, approval: { grants: [{ signature: "key:enter", process: "telegram", count: 9 }], expiresAt: 9e15 }, origin: "proactive" }, lab: { ctx: echoSession() },
    expect: { ok: true, resultIncludes: ['"mode":"down"', '"scancode":true', '"origin":"user"', '"timeoutMs":30000'], resultExcludes: [/approval/, /proactive/] },
    coversTool: "input_key",
  },
];

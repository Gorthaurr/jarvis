/**
 * G2: input_click — клик по цели. Бесшумный клик по роли идёт UIA-invoke (курсор не двигается), right/count/physical —
 * настоящий клик. Координаты живут только в кадре screen_capture (без кадра — отказ до клиента). §14 судит НАЙДЕННЫЙ
 * элемент: «Отправить» нельзя нажать в обход вопроса ни по имени, ни по пикселям. В веб-задаче мышь не двигаем.
 */
import type { ToolCase } from "../case-format.js";
import { JARVIS, NOTEPAD, TG, echoSession } from "./g2-fixtures.js";

const KATYA = { by: "role", role: "listitem", name: "Катя" };
const SEND = { by: "role", role: "button", name: "Отправить" };
/** «Отправить» в кадре labf1 (1430×804 при экране 2560×1440): экранный центр ~(1257, 868). */
const SEND_PX = { by: "coords", x: 702, y: 485 };
const draft = { tool: "ui_invoke", args: { target: { by: "role", role: "edit", name: "Написать сообщение..." }, pattern: "setValue", value: "привет" } };
const shot = { tool: "screen_capture" };
const title = (t: string) => (s: { windows: Array<{ title: string }> }): boolean | string => s.windows.some((w) => w.title === t) || `заголовки: ${s.windows.map((w) => w.title).join(" | ")}`;
const notSent = [{ none: "app.message.sent" }, { none: "ui.invoke" }, { none: "input.click" }];
const ext = { connected: true, openOrFocus: async () => ({ tabId: 7 }) } as never;

export const cases: ToolCase[] = [
  {
    tool: "input_click", name: "бесшумный клик по роли: UIA-invoke без курсора, чат переключён (заголовок окна сменился)", args: { target: KATYA }, seed: TG,
    expect: { ok: true, asked: 0, actionKinds: ["input.click"], flags: { observed: true }, effects: [{ has: "ui.invoke", detail: { name: "Катя" } }, { none: "input.click" }], state: title("Катя — Telegram") },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "правый клик — физический: эффект input.click с кнопкой right", args: { target: KATYA, button: "right" }, seed: TG,
    expect: { ok: true, actionKinds: ["input.click"], effects: [{ has: "input.click", detail: { button: "right", count: 1, node: "Катя" } }] },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "count=2 (дабл-клик) идёт физическим кликом, число кликов доехало", args: { target: KATYA, count: 2 }, seed: TG,
    expect: { ok: true, actionKinds: ["input.click"], effects: [{ has: "input.click", detail: { count: 2, node: "Катя" } }] },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "клик по пикселю кадра (physical): попал в чат «Катя» — экранная точка посчитана из кадра", before: [shot], args: { target: { by: "coords", x: 134, y: 145 }, method: "physical" }, seed: TG,
    expect: { ok: true, actionKinds: ["input.click"], effects: [{ has: "input.click", detail: { node: "Катя" } }], resultIncludes: '"screenX":239', state: title("Катя — Telegram") },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "координаты без кадра: отказ сервера ДО клиента («сначала screen_capture»)", args: { target: { by: "coords", x: 100, y: 100 } }, seed: TG,
    expect: { ok: false, actionKinds: [], resultIncludes: /координаты без кадра/, effects: notSent },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "чужой/устаревший кадр — not_found «кадр устарел», ничего не нажато", before: [shot], args: { target: { by: "coords", x: 300, y: 200, frame: "labf999" } }, seed: TG,
    expect: { ok: false, actionKinds: ["input.click"], resultIncludes: /кадр устарел/, effects: notSent },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "точка вне кадра — ошибка «вне кадра», ничего не нажато", before: [shot], args: { target: { by: "coords", x: 99999, y: 200 } }, seed: TG,
    expect: { ok: false, actionKinds: ["input.click"], resultIncludes: /вне кадра/, effects: notSent },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "«Отправить» по имени, владелец «нет»: клик не выполнен, сообщение не ушло", before: [draft], args: { target: SEND }, seed: TG, confirm: "no",
    expect: { asked: 1, actionKinds: ["input.click"], flags: { declined: true }, effects: notSent, resultIncludes: /Отменено пользователем/ },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "«Отправить» по имени, «да»: сообщение с набранным текстом ушло ровно раз", before: [draft], args: { target: SEND }, seed: TG, confirm: "yes",
    expect: { ok: true, asked: 1, actionKinds: ["input.click", "input.click"], effects: [{ has: "app.message.sent", detail: { text: "привет", via: "button" }, count: 1 }] },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "«Отправить» ПО ПИКСЕЛЮ, физически: клиент судит найденный элемент — вопрос всё равно задан, «нет» → не ушло", before: [draft, shot], args: { target: SEND_PX, method: "physical" }, seed: TG, confirm: "no",
    expect: { asked: 1, flags: { declined: true }, effects: notSent, resultIncludes: /клик «отправить»/ },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "«Отправить» по пикселю, бесшумно: тот же вопрос; «да» → одно сообщение", before: [draft, shot], args: { target: SEND_PX }, seed: TG, confirm: "yes",
    expect: { ok: true, asked: 1, effects: [{ has: "app.message.sent", detail: { text: "привет" }, count: 1 }] },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "вопрос истёк — сообщение не ушло, текст «не ответили»", before: [draft], args: { target: SEND }, seed: TG, confirm: "expire",
    expect: { asked: 1, flags: { declined: true, channelDown: false }, effects: notSent, resultIncludes: /не ответили|истекло/, resultExcludes: /Отменено пользователем/ },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "вопрос не доставлен — «не смог спросить» + channelDown", before: [draft], args: { target: SEND }, seed: TG, confirm: "undelivered",
    expect: { asked: 1, flags: { declined: true, channelDown: true }, effects: notSent, resultIncludes: /не смог спросить/, resultExcludes: /Отменено пользователем/ },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "вуаль: физический (правый) клик отклонён overlay_drawing", before: [{ tool: "screen_selection", args: { op: "start" } }], args: { target: KATYA, button: "right" }, seed: TG,
    expect: { ok: false, flags: { overlayDenied: true }, resultIncludes: /вуаль/, effects: [{ none: "input.click" }] },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "идёт веб-задача (browser_open): мышь не двигаем — отказ со стиром на browser_act, клиенту ничего", before: [{ tool: "browser_open", args: { url: "https://example.com/" } }], args: { target: KATYA }, seed: TG, lab: { ctx: { ext } },
    expect: { ok: false, actionKinds: [], resultIncludes: [/мышь НЕ двигаем/, /browser_act/], effects: notSent },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "рубеж «self»: клик по кнопке «Закрыть» окна Джарвиса отклонён без вопроса", args: { target: { by: "role", role: "button", name: "Закрыть" } }, seed: JARVIS, confirm: "yes",
    expect: { ok: false, asked: 0, resultIncludes: /самого Джарвиса/, effects: [{ none: "window.close" }], state: (s) => s.windows.some((w) => w.process === "electron") || "окно Джарвиса закрыто" },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "элемента нет — честная ошибка с подсказкой про зрение, ничего не нажато", args: { target: { by: "role", role: "button", name: "Нет такой" } }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: ["input.click"], resultIncludes: [/Элемент не найден/, /screen_capture/], effects: notSent },
    coversTool: "input_click",
  },
  {
    tool: "input_click", name: "поля схемы доезжают клиенту (method, button, count), approval/origin модели срезаны", lab: { ctx: echoSession() },
    args: { target: KATYA, method: "physical", button: "right", count: 2, approval: { grants: [{ signature: "click:отправить", process: "telegram", count: 9 }], expiresAt: 9e15 }, origin: "proactive" },
    expect: { ok: true, resultIncludes: ['"method":"physical"', '"button":"right"', '"count":2', '"origin":"user"'], resultExcludes: [/approval/, /proactive/] },
    coversTool: "input_click",
  },
];

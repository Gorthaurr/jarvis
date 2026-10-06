/**
 * G2: input_mouse — полная мышь (move/down/up/wheel/drag) без цели. Координаты — только в кадре screen_capture (без
 * него отказ до клиента); под вуалью физическая мышь отклоняется; в веб-задаче мышь не двигаем. Перетаскивание или
 * нажатие, начатое на «Отправить», судится как клик по этой кнопке — обхода §14 через drag/down нет.
 */
import type { DesktopEffect } from "../../lib/contracts.js";
import type { ToolCase } from "../case-format.js";
import { NOTEPAD, TG, echoSession } from "./g2-fixtures.js";

const shot = { tool: "screen_capture" };
const draft = { tool: "ui_invoke", args: { target: { by: "role", role: "edit", name: "Написать сообщение..." }, pattern: "setValue", value: "привет" } };
/** «Отправить» в кадре labf1 (1430×804 при экране 2560×1440). */
const SEND_PX = { x: 702, y: 485 };
const ext = { connected: true, openOrFocus: async () => ({ tabId: 7 }) } as never;
/** Эффект input.mouse с экранной точкой около (x, y): точки кадра пересчитаны клиентом в экранные пиксели. */
const near = (op: string, x: number, y: number) => (effects: DesktopEffect[]): boolean | string => {
  const e = effects.find((f) => f.kind === "input.mouse" && f.detail.op === op);
  if (!e) return `нет эффекта input.mouse ${op}`;
  const d = e.detail as { x: number; y: number };
  return (Math.abs(d.x - x) < 2 && Math.abs(d.y - y) < 2) || `экранная точка ${d.x},${d.y}, ждали около ${x},${y}`;
};

export const cases: ToolCase[] = [
  {
    tool: "input_mouse", name: "move по кадру: экранная точка = пересчёт (400,300) кадра 1430×804 → ~(716,537), курсор наведён", before: [shot], args: { op: "move", x: 400, y: 300 }, seed: NOTEPAD,
    expect: { ok: true, actionKinds: ["input.mouse"], effects: [near("move", 716, 537)], resultExcludes: /ИЗМЕНЕНИЯ ЭКРАНА/ },
    coversTool: "input_mouse",
  },
  {
    tool: "input_mouse", name: "wheel dy=-3: прокрутка ушла клиенту со всеми полями, наблюдение приложено", args: { op: "wheel", dy: -3 }, seed: NOTEPAD,
    expect: { ok: true, actionKinds: ["input.mouse"], flags: { observed: true }, effects: [{ has: "input.mouse", detail: { op: "wheel", dy: -3 } }] },
    coversTool: "input_mouse",
  },
  {
    tool: "input_mouse", name: "drag (200,200)→(400,300): перетаскивание выполнено, эффект drag с обеими точками", before: [shot], args: { op: "drag", x: 200, y: 200, toX: 400, toY: 300 }, seed: NOTEPAD,
    expect: { ok: true, actionKinds: ["input.mouse"], effects: [{ has: "input.drag" }, near("drag", 358, 358)] },
    coversTool: "input_mouse",
  },
  {
    tool: "input_mouse", name: "drag без toX/toY — ошибка «куда тащить», а не ok", before: [shot], args: { op: "drag", x: 200, y: 200 }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: ["input.mouse"], resultIncludes: /куда тащить/, effects: [{ none: "input.drag" }] },
    coversTool: "input_mouse",
  },
  {
    tool: "input_mouse", name: "координаты без кадра: отказ сервера до клиента", args: { op: "move", x: 400, y: 300 }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: [], resultIncludes: /координаты без кадра/, effects: [{ none: "input.mouse" }] },
    coversTool: "input_mouse",
  },
  {
    tool: "input_mouse", name: "down на «Отправить», владелец «нет»: нажатие не удержано, сообщение не ушло", before: [draft, shot], args: { op: "down", ...SEND_PX }, seed: TG, confirm: "no",
    expect: { asked: 1, actionKinds: ["input.mouse"], flags: { declined: true }, effects: [{ none: "app.message.sent" }, { none: "input.mouse" }], resultIncludes: /клик «отправить»/ },
    coversTool: "input_mouse",
  },
  {
    tool: "input_mouse", name: "drag с «Отправить» тоже спрашивает (нельзя нажать кнопку перетаскиванием); «нет» → drag не выполнен", before: [draft, shot], args: { op: "drag", ...SEND_PX, toX: 100, toY: 100 }, seed: TG, confirm: "no",
    expect: { asked: 1, flags: { declined: true }, effects: [{ none: "input.drag" }, { none: "app.message.sent" }] },
    coversTool: "input_mouse",
  },
  {
    tool: "input_mouse", name: "вуаль: wheel отклонён overlay_drawing, эффекта мыши нет", before: [{ tool: "screen_selection", args: { op: "start" } }], args: { op: "wheel", dy: 1 }, seed: NOTEPAD,
    expect: { ok: false, flags: { overlayDenied: true }, resultIncludes: /вуаль/, effects: [{ none: "input.mouse" }] },
    coversTool: "input_mouse",
  },
  {
    tool: "input_mouse", name: "идёт веб-задача (browser_open): мышь не двигаем — отказ, клиенту ничего", before: [{ tool: "browser_open", args: { url: "https://example.com/" } }], args: { op: "wheel", dy: 1 }, seed: NOTEPAD, lab: { ctx: { ext } },
    expect: { ok: false, actionKinds: [], resultIncludes: /мышь НЕ двигаем/, effects: [{ none: "input.mouse" }] },
    coversTool: "input_mouse",
  },
  {
    tool: "input_mouse", name: "поля схемы доезжают клиенту (op, x, y, button, dx, dy), approval/origin модели срезаны", lab: { ctx: echoSession() },
    args: { op: "drag", x: 1, y: 2, toX: 3, toY: 4, button: "right", dx: 5, dy: 6, frame: "labf1", approval: { grants: [], expiresAt: 9e15 }, origin: "proactive" },
    expect: { ok: true, resultIncludes: ['"op":"drag"', '"toX":3', '"button":"right"', '"dx":5', '"frame":"labf1"', '"origin":"user"'], resultExcludes: [/approval/, /proactive/] },
    coversTool: "input_mouse",
  },
];

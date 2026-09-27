/**
 * Схемы GUI-инструментов W2 (пакет 0): цель действия, регион экрана и главный примитив `act`.
 *
 * Вынесены из index.ts (он и так 2300+ строк): здесь W2 меняет поля — `frame` (кадр задачи) вместо `space`
 * (абсолютные DIP остаются только SDK и реплей-макросам §8), новые глаголы act и серия `steps`. Прозу про кадры,
 * лупу и новые глаголы пишет интеграция W2 — здесь только поля.
 */
import type { ToolSchema } from "./index.js";

/** Поле кадра: координаты модели относятся к кадру screen_capture, который она видела (W2, решение №6). */
const FRAME_PROP = { type: "string", description: "id кадра screen_capture, в котором видна точка." } as const;

/**
 * Target — цель действия (§6): по роли/имени (предпочтительно), по handle из
 * предыдущего ui_ground, либо по координатам (крайний vision-fallback).
 * Соответствует протокольному типу Target (discriminated по полю `by`).
 */
export const TARGET_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "Цель действия. Грундится по роли/имени (предпочтительно) или по handle из ui_ground; coords — крайний vision-fallback, использовать только если a11y-грундинг невозможен (§6).",
  oneOf: [
    {
      type: "object",
      properties: {
        by: { const: "role" },
        role: { type: "string", description: "Роль в a11y-дереве, напр. \"button\", \"edit\"." },
        name: { type: "string", description: "Видимое имя/label элемента (необязательно)." },
      },
      required: ["by", "role"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        by: { const: "handle" },
        handle: { type: "string", description: "Хендл элемента, полученный из ui_ground." },
      },
      required: ["by", "handle"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { by: { const: "coords" }, x: { type: "number" }, y: { type: "number" }, frame: FRAME_PROP },
      required: ["by", "x", "y"],
      additionalProperties: false,
    },
  ],
};

/** Регион экрана (§Волна2 2.3): координаты в кадре frame (W2), как клики by:'coords'. */
export const SCREEN_RECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "Регион экрана: x/y/w/h — в координатах полного screen_capture (как клики by:'coords').",
  properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" }, frame: FRAME_PROP },
  required: ["x", "y", "w", "h"],
  additionalProperties: false,
};

/** Цель act: строка = видимый текст; объект — уточнение (та же форма у `to` для drag). */
const ACT_TARGET_SCHEMA = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        text: { type: "string" },
        role: { type: "string", description: "Роль UIA: Button, Edit, ListItem, TabItem, MenuItem, CheckBox, ComboBox, Hyperlink, TreeItem…" },
        automationId: { type: "string" },
        handle: { type: "string", description: "handle из look{what:'elements'} — точная адресация без поиска." },
        x: { type: "number" },
        y: { type: "number" },
        frame: FRAME_PROP,
      },
      additionalProperties: false,
    },
  ],
} as const;

/** Глаголы act (W2: +triple/middle/hover/drag/scroll). Список — общий для схемы и проверки шагов (act-steps). */
export const ACT_VERBS = ["click", "double", "right", "type", "set", "toggle", "select", "expand", "key", "triple", "middle", "hover", "drag", "scroll"] as const;

/** Потолок шагов act{steps} — как у input_batch. */
export const ACT_STEPS_MAX = 12;

export const ACT_TOOL: ToolSchema = {
  name: "act",
  description:
    "ГЛАВНЫЙ инструмент рук в GUI (W4): «нажми «Отправить» в Telegram», «открой вкладку «Настройки»», «напечатай X в поле «Поиск»» — ОДНИМ вызовом. Клиент САМ находит цель лестницей (handle → UIA-снапшот активного окна по тексту/роли → локальный OCR всего экрана → элемент под точкой), делает действие БЕЗ курсора где возможно (UIA invoke; физический клик — только фолбэк или physical:true), и СВЕРЯЕТ исход: снимок структуры окна ДО/ПОСЛЕ (дельта «+появилось/−исчезло») плюс ожидание признака verify. Ответ: found{via,name,role} — что реально найдено и как; did — что сделано; verified: \"met\" (признак наступил — исход подтверждён) | \"failed\" (действие УШЛО, признак за timeoutMs не наступил — НЕ повторяй вслепую, сверь глазами: look{what:'elements'}/look{what:'text'}) | \"unchecked\" (verify не задан или сенсор не смог ответить — сверь сам); detail; наблюдение-дельта. Не найдено → ЧЕСТНАЯ ошибка со списком видимых элементов (подбери точное имя из них) — не «клик мимо с ok». Несколько одинаковых → ошибка с кандидатами (уточни role/automationId/x,y). target: строка = видимый текст элемента (кнопка/пункт/вкладка/поле), объект — {text, role, automationId, handle из look{what:'elements'}, x/y точка}. app — сперва сфокусировать окно по подстроке заголовка/процесса («Telegram», «Блокнот»); окна нет → ошибка, ничего не нажато. do: click (дефолт) | double | right | type (клик в поле + печать text; БЕЗ target — печать в поле, где фокус УЖЕ стоит: после Ctrl+K/Ctrl+L или поиска, открытого клавишей; перевод строки в text = Enter, в мессенджере спросит владельца) | set (UIA setValue text — мгновенно, для полей) | toggle | select | expand | key (нажать combo, напр. «Ctrl+S»; target не нужен). ВСЕГДА задавай verify, когда знаешь признак успеха («Отправлено», новое окно, исчезновение диалога) — это и есть сверка. §14: Enter/«Отправить»/«Оплатить» в мессенджере/банке/1С → подтверждение владельца. Игра/canvas (UIA слепа): цель по тексту найдётся через OCR; пиксельный геймплей НЕ обещай — потолок у всех агентов (OSWorld 2.0 ~20%).",
  input_schema: {
    type: "object",
    properties: {
      target: {
        description: "Строка — видимый текст элемента; ИЛИ объект {text?, role?, automationId?, handle?, x?, y?, frame?} (x/y — в кадре screen_capture).",
        ...ACT_TARGET_SCHEMA,
      },
      app: { type: "string", description: "Сначала сфокусировать окно (подстрока заголовка/процесса). Не найдено → ошибка, действие не выполняется." },
      do: { type: "string", enum: [...ACT_VERBS], description: "Действие (дефолт click)." },
      text: { type: "string", description: "Для do=type/set: что напечатать/установить." },
      combo: { type: "string", description: "Для do=key: клавиша/сочетание в нотации input_key («Enter», «Ctrl+S»)." },
      verify: {
        type: "object",
        description: "Признак исхода: text (появился на экране), element {role,name} (есть в окне), title (заголовок окна содержит); gone:true — ждать исчезновения; timeoutMs (деф 4000, макс 15000).",
        properties: {
          text: { type: "string" },
          element: { type: "object", properties: { role: { type: "string" }, name: { type: "string" } }, required: ["role"], additionalProperties: false },
          title: { type: "string" },
          gone: { type: "boolean" },
          timeoutMs: { type: "integer", minimum: 500, maximum: 15000 },
        },
        additionalProperties: false,
      },
      physical: { type: "boolean", description: "Сразу физический клик SendInput (игра/canvas, где UIA заведомо слепа)." },
      clear: { type: "boolean", description: "type: очистить поле перед печатью." },
      enter: { type: "boolean", description: "type: нажать Enter после печати." },
      to: { description: "drag: куда тащить (как target).", ...ACT_TARGET_SCHEMA },
      dx: { type: "integer", description: "scroll: тики колеса по горизонтали." },
      dy: { type: "integer", description: "scroll: тики колеса (+вверх/−вниз)." },
      observe: { type: "boolean", description: "false — без снимков до/после." },
      steps: {
        type: "array",
        maxItems: ACT_STEPS_MAX,
        description: "Серия шагов одним вызовом: каждый шаг — поля act (target, do, text, combo, verify…; app — общий сверху) или {do:\"capture\"} / {do:\"wait\", ms}. Стоп на первой ошибке.",
        items: { type: "object", additionalProperties: true },
      },
    },
    required: [],
    additionalProperties: false,
  },
};

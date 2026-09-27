/**
 * Схемы GUI-инструментов W2 (пакет 0): цель действия, регион экрана и главный примитив `act`.
 *
 * Вынесены из index.ts (он и так 2300+ строк): здесь W2 меняет поля — `frame` (кадр задачи) вместо `space`
 * (абсолютные DIP остаются только SDK и реплей-макросам §8), новые глаголы act и серия `steps`; проза про кадры,
 * лупу, новые глаголы и серию — интеграция W2 (описание act обещает ровно поведение пакетов П1/П4/П5).
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
    "ГЛАВНЫЙ инструмент рук в GUI: «нажми «Отправить» в Telegram», «напечатай X в поле «Поиск»» — ОДНИМ вызовом. Клиент САМ находит цель (handle → UIA-снапшот активного окна по тексту/роли → OCR окна app/переднего → элемент под точкой), действует БЕЗ курсора где можно (UIA invoke; физический клик — фолбэк, physical:true, а точка над крупным элементом вроде строки списка — ровно в точку) и СВЕРЯЕТ исход: дельта окна ДО/ПОСЛЕ + признак verify. Ответ: found{via,name,role}, did, verified: \"met\" (исход подтверждён) | \"failed\" (действие УШЛО, признак не наступил — НЕ повторяй вслепую, сверь: look{what:'elements'|'text'}) | \"unchecked\" (сверь сам); наблюдение-дельта. Не найдено или несколько равных → ошибка со списком видимого (уточни имя/role/automationId) — не «клик мимо с ok». target: строка = видимый текст; объект — {text, role, automationId, handle из look{what:'elements'}, x/y}. x/y — в кадре ПОСЛЕДНЕГО screen_capture задачи (кадр подставлю сам); по лупе (screen_capture{rect} — свежий снимок) кликай с её frame из ответа. app — сперва фокус окна по подстроке заголовка/процесса; окна нет → ошибка, ничего не нажато. do: click (дефолт) | double | right | triple (выделить строку) | middle | hover (тултип/ховер-меню) | scroll (колесо В цели: dy +вверх/−вниз, dx) | drag (target → to) | type (клик в поле + печать text; clear:true — очистить поле, enter:true — Enter после; БЕЗ target — в поле, где фокус УЖЕ стоит; перевод строки = Enter) | set (UIA setValue) | toggle | select | expand | key (combo, «Ctrl+S»). steps — серия до 12 шагов ОДНИМ вызовом (каждый шаг — act со всеми гейтами; {do:'capture'} — кадр в ответ, {do:'wait',ms}); стоп на первой ошибке → «выполнено k из n». ВСЕГДА задавай verify, когда знаешь признак успеха. §14: Enter/«Отправить»/«Оплатить»/«Печать» в мессенджере/банке/1С → вопрос владельцу ДО первой буквы; программа цели не определилась → честный отказ (укажи app). Игра/canvas: цель по тексту найдёт OCR; пиксельный геймплей не обещай.",
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
        description: "Серия шагов одним вызовом: каждый шаг — поля act (target, do, text, combo, verify…; app — общий сверху) или {do:\"capture\"} / {do:\"wait\", ms}. Стоп на первой ошибке; коммит спросит владельца на своём шаге.",
        items: { type: "object", additionalProperties: true },
      },
    },
    required: [],
    additionalProperties: false,
  },
};

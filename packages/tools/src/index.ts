/**
 * @jarvis/tools — JSON Schema определения инструментов мозга (§6, §12, §8).
 *
 * Каждый инструмент — объект в формате Anthropic tool-use:
 *   { name, description, input_schema } , где input_schema — валидный JSON Schema object.
 *
 * Две группы инструментов (§6):
 *  1. Актуаторы — мозг НЕ исполняет их сам, он эмитит абстрактный ActionCommand
 *     (server -> client, §5/§6); поля input_schema 1:1 повторяют поля соответствующего
 *     ActionCommand из @jarvis/protocol. Клиент мапит команду на актуатор
 *     (UIA/SendInput/hak-browser). Мозг не знает про SendInput/puppeteer.
 *  2. Server-side инструменты — мозг выполняет их на сервере, не отправляя на клиент:
 *     web_search/web_fetch (§12), memory_search/memory_write (§8).
 *
 * Гарды §14 закодированы в описаниях инструментов (текст видит модель):
 *  - message_send  -> ТРЕБУЕТ user.confirm + cadence guard (анти-спам);
 *  - order.place   -> ТРЕБУЕТ user.confirm + spend cap + идемпотентность;
 *  - code.run lang="powershell" -> ТРЕБУЕТ user.confirm + Constrained Language Mode (CLM);
 *  - карта/платёжные реквизиты НИКОГДА не вводятся и не редактируются (§0 принцип 5, §14).
 *
 * input_schema специально описан как ActionCommand БЕЗ поля `kind`: дискриминатор несёт
 * имя инструмента, а не payload. timeoutMs кладёт транспорт в конверт (§5), не модель.
 */

import type { ActionKind } from "@jarvis/protocol";

/** Инструмент в формате Anthropic tool-use (§6, §12). */
export interface ToolSchema {
  /** Уникальное имя инструмента (snake_case). */
  name: string;
  /** Описание для модели; здесь же — гарды §14 и условия применения. */
  description: string;
  /** Валидный JSON Schema object: {type:"object", properties, required, ...}. */
  input_schema: Record<string, unknown>;
}

// ───────────────────────────── Вспомогательные под-схемы ─────────────────────────────

/**
 * Target — цель действия (§6): по роли/имени (предпочтительно), по handle из
 * предыдущего ui_ground, либо по координатам (крайний vision-fallback).
 * Соответствует протокольному типу Target (discriminated по полю `by`).
 */
const TARGET_SCHEMA: Record<string, unknown> = {
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
      properties: {
        by: { const: "coords" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["by", "x", "y"],
      additionalProperties: false,
    },
  ],
};

/** UIA-паттерны для ui_invoke — основной путь действия (§6). */
const UI_PATTERN_ENUM = ["invoke", "setValue", "select", "toggle", "expand", "scroll"] as const;

/** Языки ограниченного раннера кода (§6). */
const CODE_LANG_ENUM = ["python", "node", "powershell"] as const;

/** Каналы переписки от лица пользователя (§12). */
const MESSAGE_CHANNEL_ENUM = ["vk", "telegram"] as const;

/** Удобный конструктор object-схемы. */
function obj(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

// ───────────────────────────── Актуаторы (эмитят ActionCommand, §6) ─────────────────────────────

/**
 * Имена актуаторных инструментов отображены на ActionKind протокола.
 * Карта используется и здесь (для документации соответствия), и в тестах
 * (compile-time проверка покрытия всех kind'ов через Record<ActionKind, ...>).
 */
export const ACTUATOR_TOOL_BY_KIND: Record<ActionKind, string> = {
  "app.launch": "app_launch",
  "app.focus": "app_focus",
  "ui.ground": "ui_ground",
  "ui.invoke": "ui_invoke",
  "input.type": "input_type",
  "input.key": "input_key",
  "input.click": "input_click",
  "browser.open": "browser_open",
  "browser.act": "browser_act",
  "browser.read": "browser_read",
  "code.run": "code_run",
  "skill.execute": "skill_execute",
  "screen.capture": "screen_capture",
  "context.read": "context_read",
  "demo.record": "demo_record",
  "message.send": "message_send",
  "order.place": "order_place",
};

const ACTUATOR_TOOLS: ToolSchema[] = [
  {
    name: "app_launch",
    description:
      "Запустить приложение по имени/идентификатору (ActionCommand app.launch, §6). Эмитит команду клиенту; клиент стартует процесс. Для переключения фокуса на уже запущенное окно используй app_focus.",
    input_schema: obj(
      {
        app: { type: "string", description: "Имя или идентификатор приложения для запуска." },
      },
      ["app"],
    ),
  },
  {
    name: "app_focus",
    description:
      "Переключить фокус на уже запущенное приложение/окно (ActionCommand app.focus, §6). Без захвата ввода у пользователя сверх необходимого.",
    input_schema: obj(
      {
        app: { type: "string", description: "Имя или идентификатор приложения для фокуса." },
      },
      ["app"],
    ),
  },
  {
    name: "ui_ground",
    description:
      "Найти элемент UI по роли/имени в a11y-дереве и получить его handle/bbox (ActionCommand ui.ground, §6). Результат (handle) возвращается в ActionResult.data и переиспользуется в ui_invoke/input_click через Target by:\"handle\". Это предпочтительный способ адресации перед действием — без координат и CSS-селекторов.",
    input_schema: obj(
      {
        query: obj(
          {
            role: { type: "string", description: "Роль элемента в a11y-дереве." },
            name: { type: "string", description: "Видимое имя/label (необязательно)." },
          },
          ["role"],
        ),
      },
      ["query"],
    ),
  },
  {
    name: "ui_invoke",
    description:
      "ОСНОВНОЙ путь действия (§6): выполнить UIA-паттерн над элементом по handle/роли без захвата курсора и без фокуса. Предпочитай ui_invoke синтетическому вводу (input_click/input_type). pattern=setValue требует value.",
    input_schema: obj(
      {
        target: TARGET_SCHEMA,
        pattern: {
          type: "string",
          enum: [...UI_PATTERN_ENUM],
          description:
            "UIA-паттерн: invoke (нажать), setValue (задать значение), select, toggle, expand, scroll.",
        },
        value: {
          type: "string",
          description: "Значение для pattern=setValue (иначе игнорируется).",
        },
      },
      ["target", "pattern"],
    ),
  },
  {
    name: "input_type",
    description:
      "Ввести текст синтетическим вводом в активный элемент (ActionCommand input.type, §6). FALLBACK: применяй только когда ui_invoke с pattern=setValue невозможен. ЗАПРЕЩЕНО вводить номера карт, CVV, сроки действия и иные платёжные реквизиты (§0 принцип 5, §14).",
    input_schema: obj(
      {
        text: { type: "string", description: "Текст для ввода." },
      },
      ["text"],
    ),
  },
  {
    name: "input_key",
    description:
      "Послать сочетание клавиш или одиночную клавишу (ActionCommand input.key, §6), напр. \"Ctrl+S\", \"ArrowRight\", \"Space\". FALLBACK к UIA-паттернам.",
    input_schema: obj(
      {
        combo: {
          type: "string",
          description: "Комбинация/клавиша, напр. \"Ctrl+S\", \"ArrowRight\", \"Space\".",
        },
      },
      ["combo"],
    ),
  },
  {
    name: "input_click",
    description:
      "Синтетический клик по цели (ActionCommand input.click, §6). FALLBACK: предпочитай ui_invoke (pattern=invoke). Цель по coords — крайний vision-fallback.",
    input_schema: obj(
      {
        target: TARGET_SCHEMA,
      },
      ["target"],
    ),
  },
  {
    name: "browser_open",
    description:
      "Открыть URL в браузере (ActionCommand browser.open, §6). Не переходи по подозрительным/незнакомым ссылкам без подтверждения пользователя.",
    input_schema: obj(
      {
        url: { type: "string", description: "Абсолютный URL для открытия." },
      },
      ["url"],
    ),
  },
  {
    name: "browser_act",
    description:
      "Высокоуровневое действие в hak-browser над текущей вкладкой (ActionCommand browser.act, §6): play/next/scroll/pause. params — необязательные параметры интента.",
    input_schema: obj(
      {
        intent: {
          type: "string",
          enum: ["play", "next", "scroll", "pause"],
          description: "Интент действия в браузере.",
        },
        params: {
          type: "object",
          additionalProperties: true,
          description: "Необязательные параметры интента.",
        },
      },
      ["intent"],
    ),
  },
  {
    name: "browser_read",
    description:
      "Извлечь контент из текущей страницы по интенту-селектору (ActionCommand browser.read, §6). selectorIntent — это описание ЧТО извлечь (напр. \"main article text\", \"current track title\"), а не CSS-селектор.",
    input_schema: obj(
      {
        selectorIntent: {
          type: "string",
          description: "Интент извлечения (что нужно достать со страницы), не CSS-селектор.",
        },
      },
      ["selectorIntent"],
    ),
  },
  {
    name: "code_run",
    description:
      "Выполнить короткий код в ОГРАНИЧЕННОМ раннере (ActionCommand code.run, §6). ГАРД §14: lang=\"powershell\" ВСЕГДА требует user.confirm и исполняется только в Constrained Language Mode (CLM). Не использовать для платёжных операций и работы с картой (§0 принцип 5). Код должен быть детерминированным и без сетевых секретов в открытом виде.",
    input_schema: obj(
      {
        lang: {
          type: "string",
          enum: [...CODE_LANG_ENUM],
          description: "Язык: python | node | powershell. powershell -> confirm + CLM (§14).",
        },
        code: { type: "string", description: "Исходный код для исполнения в песочнице." },
      },
      ["lang", "code"],
    ),
  },
  {
    name: "skill_execute",
    description:
      "Запустить ранее выученный скилл на клиентском skill-runner (ActionCommand skill.execute, §8). steps — шаги в терминах интентов и ролей (НИКОГДА координаты/CSS-селекторы). params — параметры подстановки. Каждый шаг с expect авто-ожидает постусловие; шаг с needsLlm=true — единственный случай легитимного обращения раннера к серверу.",
    input_schema: obj(
      {
        skillId: { type: "string", description: "Идентификатор скилла." },
        version: { type: "integer", description: "Версия скилла (целое)." },
        steps: {
          type: "array",
          description: "Шаги скилла (SkillStep §8).",
          items: obj(
            {
              action: {
                type: "string",
                description: "ActionKind или верхнеуровневый интент шага (\"ground\", \"verify\", ...).",
              },
              target: TARGET_SCHEMA,
              params: { type: "object", additionalProperties: true },
              needsLlm: {
                type: "boolean",
                description: "true — runner вызывает сервер, чтобы сочинить текст по месту.",
              },
              expect: obj({
                role: { type: "string" },
                name: { type: "string" },
                state: { type: "string" },
              }),
              timeoutMs: { type: "integer" },
              retries: { type: "integer" },
            },
            ["action"],
          ),
        },
        params: {
          type: "object",
          additionalProperties: true,
          description: "Параметры подстановки в скилл (необязательно).",
        },
      },
      ["skillId", "version", "steps"],
    ),
  },
  {
    name: "screen_capture",
    description:
      "Запросить снимок экрана клиента для vision-анализа (ActionCommand screen.capture, §6). Используй как fallback, когда a11y-грундинг не даёт цели. Параметров нет.",
    input_schema: obj({}, []),
  },
  {
    name: "context_read",
    description:
      "Прочитать текущий контекст пользователя для разрешения дейксиса (\"это\", \"вот тут\", §19) — ActionCommand context.read. scope: selection (выделение), active_window, screen.",
    input_schema: obj(
      {
        scope: {
          type: "string",
          enum: ["selection", "active_window", "screen"],
          description: "Область контекста для чтения.",
        },
      },
      ["scope"],
    ),
  },
  {
    name: "demo_record",
    description:
      "Управлять записью обучения демонстрацией (ActionCommand demo.record, §8): op=start начинает запись действий пользователя, op=stop завершает и формирует черновик скилла.",
    input_schema: obj(
      {
        op: {
          type: "string",
          enum: ["start", "stop"],
          description: "start — начать запись демонстрации, stop — завершить.",
        },
      },
      ["op"],
    ),
  },
  {
    name: "message_send",
    description:
      "Отправить сообщение от лица пользователя в мессенджер (ActionCommand message.send, §12). ГАРД §14: ВСЕГДА требует user.confirm перед отправкой И проходит cadence guard (анти-спам/ограничение частоты). Не отправляй платёжные данные. channel: vk | telegram.",
    input_schema: obj(
      {
        channel: {
          type: "string",
          enum: [...MESSAGE_CHANNEL_ENUM],
          description: "Канал переписки: vk | telegram.",
        },
        to: { type: "string", description: "Получатель (id/username/контакт в канале)." },
        body: { type: "string", description: "Текст сообщения." },
      },
      ["channel", "to", "body"],
    ),
  },
  {
    name: "order_place",
    description:
      "Оформить заказ у поставщика (ActionCommand order.place, §12). ГАРД §14: ВСЕГДА требует user.confirm, проверку spend cap (лимит траты) и идемпотентность (повтор не создаёт второй заказ). КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО вводить/хранить/редактировать карточные и платёжные реквизиты (§0 принцип 5) — оплату подтверждает и проводит сам пользователь. total — итоговая сумма для проверки лимита, не способ оплаты.",
    input_schema: obj(
      {
        vendor: { type: "string", description: "Поставщик/сервис заказа." },
        items: {
          type: "array",
          description: "Позиции заказа.",
          items: { type: "object", additionalProperties: true },
        },
        total: { type: "number", description: "Итоговая сумма (для проверки spend cap)." },
      },
      ["vendor", "items", "total"],
    ),
  },
];

// ───────────────────────────── Server-side инструменты мозга (§12) ─────────────────────────────

const WEB_TOOLS: ToolSchema[] = [
  {
    name: "web_search",
    description:
      "Веб-поиск на сервере (§12, провайдер Brave или SearXNG). Выполняется мозгом, НЕ отправляется клиенту. Возвращает ранжированный список результатов (заголовок, url, сниппет). Используй перед web_fetch, чтобы найти релевантные источники.",
    input_schema: obj(
      {
        query: { type: "string", description: "Поисковый запрос." },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Сколько результатов вернуть (по умолчанию провайдер решает).",
        },
        lang: { type: "string", description: "Код языка результатов, напр. \"ru\" (необязательно)." },
      },
      ["query"],
    ),
  },
  {
    name: "web_fetch",
    description:
      "Загрузить страницу по URL и извлечь основной читаемый текст (readability) на сервере (§12). Выполняется мозгом, НЕ отправляется клиенту. Не переходи по подозрительным ссылкам из непроверенных источников без необходимости.",
    input_schema: obj(
      {
        url: { type: "string", description: "Абсолютный URL для загрузки." },
        maxChars: {
          type: "integer",
          minimum: 1,
          description: "Ограничение длины извлечённого текста (необязательно).",
        },
      },
      ["url"],
    ),
  },
];

// ───────────────────────────── Память (§8) ─────────────────────────────

const MEMORY_TOOLS: ToolSchema[] = [
  {
    name: "memory_search",
    description:
      "Поиск по эпизодической памяти (§8): найти релевантные прошлые эпизоды/факты по запросу. Выполняется мозгом на сервере. Используй для восстановления контекста о пользователе и прошлых задачах перед действием.",
    input_schema: obj(
      {
        query: { type: "string", description: "Запрос для семантического поиска по памяти." },
        topK: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Сколько эпизодов вернуть (по умолчанию небольшое значение).",
        },
        kind: {
          type: "string",
          enum: ["episodic", "semantic"],
          description: "Тип памяти для поиска (по умолчанию episodic, §8).",
        },
      },
      ["query"],
    ),
  },
  {
    name: "memory_write",
    description:
      "Записать новый эпизод/факт в память (§8). Выполняется мозгом на сервере. НЕ записывай секреты, пароли и платёжные реквизиты (§0 принцип 5, §14). Сохраняй устойчивые предпочтения и итоги задач, не сиюминутный шум.",
    input_schema: obj(
      {
        content: { type: "string", description: "Содержимое для сохранения в память." },
        kind: {
          type: "string",
          enum: ["episodic", "semantic"],
          description: "Тип записи (episodic — событие, semantic — устойчивый факт).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Теги для последующего поиска (необязательно).",
        },
      },
      ["content"],
    ),
  },
];

// ───────────────────────────── Сборка и индекс ─────────────────────────────

/** Полный набор инструментов мозга (§6 актуаторы + §12 web + §8 память). */
export const TOOL_SCHEMAS: ToolSchema[] = [
  ...ACTUATOR_TOOLS,
  ...WEB_TOOLS,
  ...MEMORY_TOOLS,
];

/** Индекс инструментов по имени для быстрого резолва при tool-use. */
export const TOOLS_BY_NAME: Record<string, ToolSchema> = Object.fromEntries(
  TOOL_SCHEMAS.map((t) => [t.name, t]),
);

/** Имена всех актуаторных инструментов (эмитят ActionCommand). Полезно для гейтинга на клиенте. */
export const ACTUATOR_TOOL_NAMES: readonly string[] = Object.values(ACTUATOR_TOOL_BY_KIND);

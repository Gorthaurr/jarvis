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
  "telegram.send": "telegram_send", // невидимо через браузер Джарвиса (НЕ userbot/MTProto)
  "telegram.read": "telegram_read", // чтение чата через браузер Джарвиса
  "jbrowser.open": "web_open", // общие невидимые веб-примитивы браузера Джарвиса
  "jbrowser.read": "web_read",
  "jbrowser.act": "web_act",
  "jbrowser.login": "web_login", // открыть сервис ВИДИМО для одноразового входа

  "order.place": "order_place",
  // Файловая система (§6).
  "fs.read": "fs_read",
  "fs.write": "fs_write",
  "fs.append": "fs_append",
  "fs.list": "fs_list",
  "fs.delete": "fs_delete",
  "fs.move": "fs_move",
  "fs.mkdir": "fs_mkdir",
  "fs.search": "fs_search",
  // Системное управление (§6).
  "system.lock": "system_lock",
  "system.power": "system_power",
  "system.media": "system_media",
  "system.volume": "system_volume",
  "system.clipboard": "system_clipboard",
  // Office как живые приложения (§6).
  "office.excel": "office_excel",
  "office.word": "office_word",
  // Мультимонитор (§6).
  "monitor.set": "monitor_set",
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
      "Послать сочетание клавиш или одиночную клавишу (ActionCommand input.key, §6), напр. \"Ctrl+S\", \"ArrowRight\", \"Space\", \"W\". " +
      "Для ИГР: mode=\"down\" нажимает и УДЕРЖИВАЕТ клавишу (движение), mode=\"up\" отпускает; scancode=true шлёт сканкодами (нужно играм на DirectInput/RawInput, иначе они не видят ввод). По умолчанию mode=\"press\" (нажать+отпустить), scancode=false.",
    input_schema: obj(
      {
        combo: {
          type: "string",
          description: "Комбинация/клавиша, напр. \"Ctrl+S\", \"ArrowRight\", \"Space\", \"W\".",
        },
        mode: {
          type: "string",
          enum: ["press", "down", "up"],
          description: "press — нажать+отпустить; down — удержать (игры/движение); up — отпустить.",
        },
        scancode: {
          type: "boolean",
          description: "true — слать сканкодами (для игр DirectInput/RawInput).",
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
      "Действие в управляемом браузере над текущей страницей (ActionCommand browser.act, §6, CDP). " +
      "intent: play/pause/next/prev (медиа), scroll (params.dy), back/forward (история), click (params.text — по видимому тексту, или params.selector), type (params.text в фокус/поле, params.selector). " +
      "Элементы ищутся по ВИДИМОМУ тексту/aria, не по пикселям. Перед действием обычно нужен browser_open (открыть страницу) и/или browser_read (понять, что на ней).",
    input_schema: obj(
      {
        intent: {
          type: "string",
          enum: ["play", "pause", "next", "prev", "scroll", "click", "type", "back", "forward"],
          description: "Интент действия в браузере.",
        },
        params: {
          type: "object",
          additionalProperties: true,
          description: "Параметры: text (для click/type), selector (CSS, опц.), dy (для scroll).",
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

// ───────────────────────────── Файловая система (§6) ─────────────────────────────
// Прямое управление файлами на машине пользователя. Путь — абсолютный Windows-путь
// (C:\\Users\\...) или относительный. Поддерживаются переменные окружения вида %USERPROFILE%.

const FS_TOOLS: ToolSchema[] = [
  {
    name: "fs_read",
    description:
      "Прочитать текстовый файл и вернуть его содержимое (ActionCommand fs.read, §6). Для больших файлов задай maxBytes. Бинарные файлы не для этого инструмента.",
    input_schema: obj(
      {
        path: { type: "string", description: "Путь к файлу (абсолютный или с %USERPROFILE% и т.п.)." },
        maxBytes: { type: "integer", minimum: 1, description: "Лимит читаемых байт (необязательно)." },
      },
      ["path"],
    ),
  },
  {
    name: "fs_write",
    description:
      "Создать новый файл ИЛИ перезаписать существующий заданным содержимым (ActionCommand fs.write, §6). Это основной способ «создать/изменить файл». createDirs=true — создать недостающие родительские каталоги. Перезапись существующего файла теряет прежнее содержимое — будь уверен в пути.",
    input_schema: obj(
      {
        path: { type: "string", description: "Путь к файлу для создания/перезаписи." },
        content: { type: "string", description: "Новое полное содержимое файла." },
        createDirs: { type: "boolean", description: "Создать недостающие родительские каталоги." },
      },
      ["path", "content"],
    ),
  },
  {
    name: "fs_append",
    description:
      "Дописать текст в конец файла, не затирая прежнее (ActionCommand fs.append, §6). Если файла нет — он создаётся.",
    input_schema: obj(
      {
        path: { type: "string", description: "Путь к файлу." },
        content: { type: "string", description: "Текст для добавления в конец." },
      },
      ["path", "content"],
    ),
  },
  {
    name: "fs_list",
    description:
      "Перечислить содержимое каталога: файлы и подкаталоги с размером и типом (ActionCommand fs.list, §6). recursive=true — обойти вложенные каталоги.",
    input_schema: obj(
      {
        path: { type: "string", description: "Путь к каталогу." },
        recursive: { type: "boolean", description: "Рекурсивный обход (осторожно на больших деревьях)." },
      },
      ["path"],
    ),
  },
  {
    name: "fs_delete",
    description:
      "Удалить файл или каталог (ActionCommand fs.delete, §6). НЕОБРАТИМО → ВСЕГДА требует user.confirm (§4). Для непустого каталога нужен recursive=true. Будь предельно внимателен к пути.",
    input_schema: obj(
      {
        path: { type: "string", description: "Путь к файлу или каталогу для удаления." },
        recursive: { type: "boolean", description: "Удалить каталог со всем содержимым." },
      },
      ["path"],
    ),
  },
  {
    name: "fs_move",
    description:
      "Переместить или переименовать файл/каталог (ActionCommand fs.move, §6). Если to существует — будет перезаписан.",
    input_schema: obj(
      {
        from: { type: "string", description: "Исходный путь." },
        to: { type: "string", description: "Целевой путь (новое имя/расположение)." },
      },
      ["from", "to"],
    ),
  },
  {
    name: "fs_mkdir",
    description:
      "Создать каталог, включая недостающие родительские (ActionCommand fs.mkdir, §6).",
    input_schema: obj(
      {
        path: { type: "string", description: "Путь создаваемого каталога." },
      },
      ["path"],
    ),
  },
  {
    name: "fs_search",
    description:
      "Найти файлы по имени или по содержимому внутри каталога (ActionCommand fs.search, §6). inContent=true — искать query внутри текстовых файлов; иначе — по именам файлов. Возвращает список путей с совпадениями.",
    input_schema: obj(
      {
        root: { type: "string", description: "Корневой каталог поиска." },
        query: { type: "string", description: "Подстрока для поиска (в имени или в содержимом)." },
        inContent: { type: "boolean", description: "Искать внутри содержимого файлов." },
        maxResults: { type: "integer", minimum: 1, description: "Максимум результатов (необязательно)." },
      },
      ["root", "query"],
    ),
  },
];

// ───────────────────────────── Системное управление (§6) ─────────────────────────────

const SYSTEM_TOOLS: ToolSchema[] = [
  {
    name: "monitor_set",
    description:
      "Куда уводить ВИДИМУЮ активность Джарвиса на мультимониторе (ActionCommand monitor.set, §6). target='jarvis' — рабочий монитор Джарвиса (по умолчанию вторичный, чтобы не мешать пользователю); target='primary' — основной монитор пользователя. Зови на «выведи на основной монитор» → primary; «верни на свой / на второй монитор» → jarvis. Это меняет, где открываются окна/браузер Джарвиса.",
    input_schema: obj(
      {
        target: {
          type: "string",
          enum: ["jarvis", "primary"],
          description: "jarvis — рабочий монитор Джарвиса; primary — основной монитор пользователя.",
        },
      },
      ["target"],
    ),
  },
  {
    name: "system_lock",
    description:
      "Заблокировать рабочую станцию (экран блокировки Windows) — ActionCommand system.lock, §6. Безопасно и обратимо (разблокировать может только пользователь), confirm НЕ требуется. Используй на просьбы «заблокируй компьютер», «закрой доступ».",
    input_schema: obj({}, []),
  },
  {
    name: "system_power",
    description:
      "Управление питанием ОС (ActionCommand system.power, §6): sleep (сон), shutdown (выключение), restart (перезагрузка), logoff (выход из сеанса). shutdown/restart/logoff НЕОБРАТИМЫ и теряют несохранённую работу → ВСЕГДА требуют user.confirm (§4). sleep/блокировка — без confirm.",
    input_schema: obj(
      {
        op: {
          type: "string",
          enum: ["sleep", "shutdown", "restart", "logoff"],
          description: "Операция питания.",
        },
      },
      ["op"],
    ),
  },
  {
    name: "system_media",
    description:
      "Глобальное управление медиа через media-клавиши (ActionCommand system.media, §6): play, pause, next, prev, stop. Действует на текущий медиаплеер/браузер.",
    input_schema: obj(
      {
        op: {
          type: "string",
          enum: ["play", "pause", "next", "prev", "stop"],
          description: "Медиа-команда.",
        },
      },
      ["op"],
    ),
  },
  {
    name: "system_volume",
    description:
      "Управление громкостью системы (ActionCommand system.volume, §6): set (задать level 0..100), mute (тишина/возврат), up, down.",
    input_schema: obj(
      {
        op: {
          type: "string",
          enum: ["set", "mute", "up", "down"],
          description: "Операция громкости.",
        },
        level: { type: "integer", minimum: 0, maximum: 100, description: "Уровень для op=set (0..100)." },
      },
      ["op"],
    ),
  },
  {
    name: "system_clipboard",
    description:
      "Чтение/запись системного буфера обмена (ActionCommand system.clipboard, §6): op=read возвращает текст буфера, op=write кладёт text в буфер. Не помещай в буфер платёжные реквизиты (§0).",
    input_schema: obj(
      {
        op: { type: "string", enum: ["read", "write"], description: "read — прочитать, write — записать." },
        text: { type: "string", description: "Текст для op=write." },
      },
      ["op"],
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

// ─────────────────────── Мессенджеры через браузер Джарвиса (§6) ───────────────────────

const MESSAGING_TOOLS: ToolSchema[] = [
  {
    name: "telegram_send",
    description:
      "Отправить сообщение в Telegram контакту через НЕВИДИМЫЙ браузер Джарвиса (его залогиненный профиль web.telegram.org, окно за экраном — пользователь не видит, фокус не крадётся). Это правильный способ написать в Telegram. НЕ открывай видимое окно (browser_open/app_launch) и НЕ води интерфейс руками — один вызов сам найдёт контакт и отправит. «Избранное»/Saved Messages поддержано. Если точного чата нет — вернётся СПИСОК видимых чатов: посмотри на него и САМ выбери нужный по смыслу (напр. пользователь сказал «Катя» → в списке «Катя Любимая» — это она), затем повтори с ТОЧНЫМ названием. Если «не залогинен» — Джарвис откроет окно входа, попроси войти.",
    input_schema: obj(
      {
        to: { type: "string", description: "Имя/контакт получателя как в Telegram (напр. «Катя»), либо «Избранное»." },
        text: { type: "string", description: "Текст сообщения." },
      },
      ["to", "text"],
    ),
  },
  {
    name: "telegram_read",
    description:
      "Прочитать последние сообщения чата в Telegram через невидимый браузер Джарвиса (его залогиненная сессия). Используй, когда пользователь спрашивает «что мне написал/ответил X», «прочитай переписку с X», «что нового в Telegram». Возвращает список последних сообщений с направлением (in=входящее, out=исходящее). Если точного чата нет — вернётся СПИСОК видимых чатов: посмотри и САМ выбери нужный по смыслу (напр. «Катя» → «Катя Любимая»), повтори с ТОЧНЫМ названием. Альтернатива — посмотреть Telegram самому через web_open/web_read и решить.",
    input_schema: obj(
      {
        to: { type: "string", description: "Имя/контакт чата как в Telegram (напр. «Катя»), либо «Избранное»." },
        count: { type: "integer", minimum: 1, maximum: 50, description: "Сколько последних сообщений вернуть (по умолчанию ~12)." },
      },
      ["to"],
    ),
  },
];

// ─────────────── «Браузер Джарвиса» — общие невидимые веб-примитивы (§6) ───────────────
// Его СОБСТВЕННЫЙ залогиненный Chrome (Telegram/Google/…), окно за экраном. Этим Джарвис
// читает/действует на аккаунтах пользователя САМ, без хардкода под каждый сервис. Отдельно
// от browser_* (те — ВИДИМО показать сайт пользователю в его обычном браузере).

const JARVIS_BROWSER_TOOLS: ToolSchema[] = [
  {
    name: "web_open",
    description:
      "Открыть URL в СВОЁМ (Джарвиса) невидимом залогиненном браузере и вернуть читаемый текст страницы. Используй, чтобы самому зайти на сервис пользователя (почта, YouTube, соцсеть и т.п.) и что-то прочитать/сделать — НЕЗАМЕТНО, не показывая пользователю. Для «покажи мне сайт на экране» используй browser_open, а не это.",
    input_schema: obj({ url: { type: "string", description: "Полный URL (https://…)." } }, ["url"]),
  },
  {
    name: "web_read",
    description:
      "Прочитать читаемый текст ТЕКУЩЕЙ страницы в браузере Джарвиса (после web_open/web_act). Возвращает title/url/text.",
    input_schema: obj({}, []),
  },
  {
    name: "web_act",
    description:
      "Действие на текущей странице браузера Джарвиса: click (по тексту или CSS-селектору), type (ввести текст в фокус/селектор), scroll (прокрутить), key (нажать Enter/Tab/Escape). Композируется с web_open/web_read для автономной работы на сайте.",
    input_schema: obj(
      {
        intent: { type: "string", enum: ["click", "type", "scroll", "key"], description: "Тип действия." },
        params: {
          type: "object",
          description: "Параметры: для click — {text} или {selector}; для type — {text, selector?}; для scroll — {dy}; для key — {key:'Enter'|'Tab'|'Escape'}.",
        },
      },
      ["intent"],
    ),
  },
  {
    name: "web_login",
    description:
      "ВХОД В СЕРВИС. Используй, когда в своём (невидимом) браузере ты НЕ ЗАЛОГИНЕН: web_read показывает страницу входа/форму логина, «Войти»/«Sign in»/«Log in», требование авторизации, или web_open привёл на пустую/логин-страницу. Открывает указанную страницу ВИДИМО в ТВОЁМ браузере (тот же профиль) — пользователь входит сам ОДИН раз (ты НЕ вводишь его пароль), после чего ты продолжаешь работать на этом сервисе НЕВИДИМО (логин сохраняется в профиле). Дай url страницы входа сервиса (напр. https://vk.com или https://m.vk.com/login), затем коротко попроси пользователя войти и сказать, когда готов; после этого повтори действие через web_open/web_act.",
    input_schema: obj(
      { url: { type: "string", description: "URL страницы входа сервиса (https://…)." } },
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

// ───────────────────────────── Office: живые Word/Excel (§6) ─────────────────────────────

const OFFICE_TOOLS: ToolSchema[] = [
  {
    name: "office_excel",
    description:
      "Работа с Excel-книгой через живое приложение (ActionCommand office.excel, §6, COM). " +
      "op=read — прочитать значения (range «A1:C10» или весь лист) → вернёт таблицу; op=write_cell — записать value в ячейку cell (напр. «B2») и сохранить; op=append_row — дописать строку row (массив значений) в конец листа и сохранить. " +
      "Если файла нет — для записи он создаётся. sheet — имя листа (по умолчанию первый). Требуется установленный Excel; если его нет — действие вернёт ошибку (тогда работай с .xlsx как с файлом через code_run + openpyxl).",
    input_schema: obj(
      {
        op: { type: "string", enum: ["read", "write_cell", "append_row"], description: "read | write_cell | append_row." },
        path: { type: "string", description: "Путь к .xlsx (абсолютный)." },
        sheet: { type: "string", description: "Имя листа (по умолчанию первый/активный)." },
        range: { type: "string", description: "Для read: диапазон «A1:C10» (пусто = весь заполненный лист)." },
        cell: { type: "string", description: "Для write_cell: адрес ячейки, напр. «B2»." },
        value: { type: "string", description: "Для write_cell: записываемое значение." },
        row: { type: "array", items: { type: "string" }, description: "Для append_row: значения новой строки." },
      },
      ["op", "path"],
    ),
  },
  {
    name: "office_word",
    description:
      "Работа с Word-документом через живое приложение (ActionCommand office.word, §6, COM). " +
      "op=read — вернуть текст документа; op=write — заменить всё содержимое на text и сохранить; op=append — дописать абзац text в конец и сохранить. " +
      "Если файла нет — для записи он создаётся. Требуется установленный Word; если его нет — действие вернёт ошибку (тогда работай с .docx через code_run + python-docx).",
    input_schema: obj(
      {
        op: { type: "string", enum: ["read", "write", "append"], description: "read | write | append." },
        path: { type: "string", description: "Путь к .docx (абсолютный)." },
        text: { type: "string", description: "Для write/append: текст." },
      },
      ["op", "path"],
    ),
  },
];

// ───────────────────────────── Саморасширение (§8+): пишет инструменты сам ─────────────────────────────

const META_TOOLS: ToolSchema[] = [
  {
    name: "tool_create",
    description:
      "СОЗДАТЬ СЕБЕ НОВЫЙ ИНСТРУМЕНТ, когда штатных не хватает (саморасширение). Сохраняет именованный шаблон кода; после этого инструмент становится вызываемым по имени на следующих ходах (переживает рестарт — это твой навык). " +
      "Код пишется на python|node|powershell и исполняется в ограниченном раннере (гард §6: без реестра/служб/сети/системных путей; powershell → confirm). Параметры подставляются в шаблон через плейсхолдеры {{имя}}. " +
      "Используй, когда задача повторяемая и нет готового инструмента: напиши код один раз — дальше вызывай как обычный инструмент.",
    input_schema: obj(
      {
        name: { type: "string", description: "Уникальное имя snake_case (3-41 симв., с буквы). Не повторяй имена встроенных инструментов." },
        description: { type: "string", description: "Что делает инструмент и когда применять (это увидит модель в наборе)." },
        lang: { type: "string", enum: [...CODE_LANG_ENUM], description: "Язык кода: python | node | powershell." },
        code: { type: "string", description: "Шаблон кода. Параметры — через {{имя}}. Выводит результат в stdout." },
        params: {
          type: "array",
          description: "Параметры инструмента (имена для подстановки {{имя}}).",
          items: obj(
            {
              name: { type: "string", description: "Имя параметра (snake_case)." },
              description: { type: "string", description: "Назначение параметра." },
            },
            ["name"],
          ),
        },
      },
      ["name", "description", "lang", "code"],
    ),
  },
  {
    name: "tool_list",
    description: "Список ранее созданных самописных инструментов (имя, описание, язык). Проверь перед созданием нового — возможно, нужный уже есть.",
    input_schema: obj({}, []),
  },
  {
    name: "tool_remove",
    description: "Удалить самописный инструмент по имени (если устарел/сломан).",
    input_schema: obj({ name: { type: "string", description: "Имя инструмента для удаления." } }, ["name"]),
  },
];

// ───────────────────────────── Навыки, выученные показом (§8) ─────────────────────────────

const SKILL_TOOLS: ToolSchema[] = [
  {
    name: "skill_list",
    description:
      "Список выученных навыков (записанных демонстрацией): id, имя, версия. Посмотри перед тем как делать многошаговую задачу руками — возможно, навык уже есть и его можно просто запустить через skill_execute.",
    input_schema: obj({}, []),
  },
  {
    name: "skill_execute",
    description:
      "Запустить ВЫУЧЕННЫЙ навык по id (ActionCommand skill.execute, §8). Шаги навыка резолвит сервер — тебе нужен только skillId (из skill_list) и опц. params для подстановки. Навыки с guard-шагами (отправка/заказ/код) требуют подтверждения перед запуском. Это $0-путь: повтор выученного без LLM-перебора.",
    input_schema: obj(
      {
        skillId: { type: "string", description: "Идентификатор навыка из skill_list." },
        params: { type: "object", additionalProperties: true, description: "Параметры подстановки (необязательно)." },
      },
      ["skillId"],
    ),
  },
  {
    name: "skill_save",
    description:
      "СОХРАНИТЬ СЕБЕ НАВЫК-ПРОЦЕДУРУ после того, как сам разобрался со сложной (многошаговой) задачей и готового навыка не было (§8, самообучение). Навык — это НЕ реплей кликов, а инструкция-памятка для тебя самого: в следующий раз, столкнувшись с похожей задачей, ты увидишь её и сразу пойдёшь по проверенному пути, а не будешь искать заново. " +
      "procedure — markdown: шаги по порядку, на что обратить внимание (грабли), как проверить, что получилось. Описывай ОБОБЩЁННО, без разовых значений (конкретных имён/текстов/путей этой задачи) — чтобы приём переиспользовался. when — когда применять (по какой просьбе пользователя). Если задача разовая и приём не пригодится снова — НЕ сохраняй.",
    input_schema: obj(
      {
        name: { type: "string", description: "Короткое имя навыка (напр. «Отправить отчёт в Telegram»)." },
        when: { type: "string", description: "Когда применять: по какому запросу/ситуации этот навык подходит." },
        procedure: {
          type: "string",
          description:
            "Markdown-процедура: шаги по порядку + грабли + как проверить результат. Обобщённо, без разовых значений.",
        },
      },
      ["name", "when", "procedure"],
    ),
  },
];

// ───────────────────────────── Сборка и индекс ─────────────────────────────

/** Полный набор инструментов мозга (§6 актуаторы + fs/system + самописные + §12 web + §8 память). */
export const TOOL_SCHEMAS: ToolSchema[] = [
  ...ACTUATOR_TOOLS,
  ...FS_TOOLS,
  ...SYSTEM_TOOLS,
  ...OFFICE_TOOLS,
  ...SKILL_TOOLS,
  ...META_TOOLS,
  ...MESSAGING_TOOLS,
  ...JARVIS_BROWSER_TOOLS,
  ...WEB_TOOLS,
  ...MEMORY_TOOLS,
];

/** Индекс инструментов по имени для быстрого резолва при tool-use. */
export const TOOLS_BY_NAME: Record<string, ToolSchema> = Object.fromEntries(
  TOOL_SCHEMAS.map((t) => [t.name, t]),
);

/** Имена всех актуаторных инструментов (эмитят ActionCommand). Полезно для гейтинга на клиенте. */
export const ACTUATOR_TOOL_NAMES: readonly string[] = Object.values(ACTUATOR_TOOL_BY_KIND);

/**
 * Реверс {@link ACTUATOR_TOOL_BY_KIND}: имя инструмента → вид команды. Единый
 * источник правды для всех, кому нужно «по имени инструмента узнать ActionKind»
 * (диспетчер §6, классификация аренды ввода §20) — не дублировать reverse в каждом.
 */
export const ACTUATOR_KIND_BY_TOOL: Record<string, ActionKind> = Object.fromEntries(
  (Object.entries(ACTUATOR_TOOL_BY_KIND) as [ActionKind, string][]).map(([kind, tool]) => [tool, kind]),
);

/**
 * Актуаторы и грундинг (§6).
 *
 * Замковый камень: цель действия резолвится по роли/имени в a11y-дереве;
 * пиксели/DOM — только vision-fallback. Скилл хранит шаги в терминах
 * интентов и ролей, НИКОГДА не координаты и не CSS-селекторы.
 *
 * Brain эмитит абстрактные ActionCommand; клиент мапит их на актуаторы.
 * Brain не знает про SendInput/puppeteer.
 */

/**
 * Цель действия. Грундится по роли/имени; coords — крайний fallback (§6).
 */
export type Target =
  | { by: "role"; role: string; name?: string }
  | { by: "handle"; handle: string } // из предыдущего ui.ground
  // coords: по умолчанию — vision-координаты ПОСЛЕДНЕГО screen_capture (клиент переводит через
  // маппинг снимка). space="screen" — АБСОЛЮТНЫЕ экранные DIP virtual-desktop, без маппинга
  // (реплей-макросы §8: клик записан в разрешённых координатах и воспроизводится без скрина).
  | { by: "coords"; x: number; y: number; space?: "screen" };

/** UIA-паттерны для ui.invoke — ОСНОВНОЙ путь действия (по handle, без фокуса/захвата курсора, §6). */
export type UiPattern =
  | "invoke" // InvokePattern
  | "setValue" // ValuePattern.SetValue
  | "select" // SelectionItemPattern
  | "toggle" // TogglePattern
  | "expand" // ExpandCollapsePattern
  | "scroll"; // ScrollPattern

/** Языки ограниченного раннера кода (§6). powershell — ВСЕГДА confirm + CLM. */
export type CodeLang = "python" | "node" | "powershell";

/** Канал переписки от лица пользователя (§12). */
export type MessageChannel = "vk" | "telegram";

/** Кнопка мыши (§Волна2 2.4). */
export type MouseButton = "left" | "right" | "middle";

/**
 * Регион экрана (§Волна2 2.3): по умолчанию — в координатах ПОСЛЕДНЕГО полного screen_capture
 * (как Target.coords); space="screen" — абсолютные экранные DIP virtual-desktop без маппинга.
 */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
  space?: "screen";
}

/**
 * Условие клиентского ожидания wait.for (§Волна2 2.3) — проверяется поллингом НА КЛИЕНТЕ,
 * без LLM-раундов. gone=true — ждать ИСЧЕЗНОВЕНИЯ (окно закрылось, спиннер пропал).
 *  - ui: элемент в UIA-дереве (роль+имя, nameMode как у ui.ground);
 *  - window: окно верхнего уровня по подстроке заголовка / имени процесса;
 *  - text: текст на экране через локальный OCR (регион/монитор — как screen.ocr);
 *  - sound: системный звук идёт/нет (WASAPI peak, как system.media state).
 */
export type WaitCondition =
  | { kind: "ui"; role: string; name?: string; nameMode?: "exact" | "substring"; gone?: boolean }
  | { kind: "window"; titleContains?: string; process?: string; gone?: boolean }
  | { kind: "text"; text: string; monitor?: string | number; rect?: ScreenRect; gone?: boolean }
  | { kind: "sound"; playing: boolean }
  // §Волна3 (3.4): состояние, ЗАПУШЕННОЕ программой на локальный GSI-листенер клиента (напр. Dota 2
  // Game State Integration): source — имя канала (путь пуша /<source>), path — точка в JSON
  // («map.game_state»), equals/contains — критерий. Generic-механизм, НЕ хардкод игры: любая
  // программа, умеющая пушить JSON на http://127.0.0.1:<порт>/<source>, становится наблюдаемой.
  | { kind: "gsi"; source?: string; path: string; equals?: string; contains?: string; gone?: boolean };

/**
 * Операции питания ОС. shutdown/restart/logoff необратимы → confirm (§4).
 * shutdown/restart исполняются С ЗАДЕРЖКОЙ и предупреждением ОС (окно отмены), а не мгновенно;
 * `cancel` отменяет запланированное выключение/перезагрузку (безопасно, без confirm).
 */
export type PowerOp = "sleep" | "shutdown" | "restart" | "logoff" | "cancel";

/** Управление медиа (глобальные media-клавиши). */
export type MediaOp = "play" | "pause" | "next" | "prev" | "stop" | "state";

/** Управление громкостью. set требует level (0..100). */
export type VolumeOp = "set" | "mute" | "up" | "down" | "get";

/** Операции Excel (через COM). */
export type ExcelOp = "read" | "write_cell" | "append_row";

/** Операции Word (через COM). */
export type WordOp = "read" | "write" | "append";

/**
 * Абстрактная команда действия (server -> client).
 * Конверт: envelope.id = commandId; payload несёт timeoutMs (§5).
 */
/**
 * `proactive?` — команда инициирована САМИМ Джарвисом (напоминание/проактив), а НЕ в ответ на просьбу юзера.
 * Сторож USER_BUSY (`actuators/index.ts`) глушит физический ввод (мышь/клава) ТОЛЬКО при `proactive===true`
 * — ЗАПРОШЕННОЕ юзером действие НЕ блокируется (он сам попросил, мешать тут нечему). По умолчанию
 * (undefined/false) = реактивная команда = выполняется, даже если юзер сейчас за вводом.
 */
export type ActionCommand = ActionCommandKind & {
  proactive?: boolean;
  /**
   * Происхождение хода (ставится СЕРВЕРОМ, не моделью): "user" = явная реплика юзера → физ.ввод НЕ гейтить
   * (он сам попросил); "proactive" = само-инициатива Джарвиса → гейт присутствия глушит физ.ввод при активном
   * юзере. Канон; `proactive` оставлен для совместимости (proactive===true эквивалент origin==="proactive").
   */
  origin?: "user" | "proactive";
};

type ActionCommandKind =
  | { kind: "input.type"; text: string }
  | {
      kind: "input.key";
      combo: string; // "Ctrl+S", "ArrowRight", "Space", "W"
      mode?: "press" | "down" | "up"; // press (по умолч.), down (удержать), up (отпустить) — для игр
      scancode?: boolean; // true → слать сканкодами (DirectInput/RawInput игр)
    }
  // input.click — §6 клик. method (клиент выбирает лестницу деградации): "silent" (дефолт на десктопе) =
  // без движения физ.курсора (UIA-invoke по handle/координатам → оконное сообщение → физ.клик С ВОЗВРАТОМ
  // курсора); "physical" = сразу SendInput (игры/canvas, где silent заведомо не сработает — не тратим round-trip).
  // §Волна2 (2.4): button (right/middle — контекстные меню), count=2 (дабл-клик).
  | { kind: "input.click"; target: Target; method?: "silent" | "physical"; button?: MouseButton; count?: number }
  // §Волна2 (2.4): полная мышь — hover/удержание/колесо/перетаскивание (игры, DnD, контекст-меню).
  // Координаты — как у input.click coords (vision-координаты последнего screen_capture; space:"screen" = абсолютные DIP).
  | {
      kind: "input.mouse";
      op: "move" | "down" | "up" | "wheel" | "drag";
      x?: number;
      y?: number;
      toX?: number; // drag: куда
      toY?: number;
      button?: MouseButton;
      dy?: number; // wheel: вертикальные тики (+вверх/−вниз)
      dx?: number; // wheel: горизонтальные тики
      space?: "screen"; // как у Target.coords: абсолютные экранные DIP без маппинга снимка
    }
  | { kind: "ui.invoke"; target: Target; pattern: UiPattern; value?: string } // UIA-паттерны — ОСНОВНОЙ путь
  // §Волна2 (2.4): nameMode="substring" — матч имени по вхождению; automationId — устойчивый id элемента.
  | { kind: "ui.ground"; query: { role: string; name?: string; nameMode?: "exact" | "substring"; automationId?: string } } // -> handle/bbox в ActionResult.data
  // §Волна2 (2.4): set-of-marks — интерактивные элементы окна {handle, role, name, automationId, bbox}
  // одним дешёвым списком (~сотни токенов текста вместо 2K-скрина). pid не задан → активное окно.
  | { kind: "ui.snapshot"; pid?: number; maxItems?: number }
  // §Волна2 (2.4): окна верхнего уровня on-demand (hwnd/pid/process/title/foreground/minimized).
  | { kind: "window.list" }
  // §Волна2 (2.4): фокус окна по hwnd (из window.list) или подстроке заголовка/имени процесса —
  // SetForegroundWindow с ЧЕСТНЫМ readback (focused=false → фокус реально не взят).
  | { kind: "window.focus"; hwnd?: number; query?: string }
  | { kind: "app.launch"; app: string }
  | { kind: "app.focus"; app: string }
  // Закрыть приложение ПО ПРОЦЕССУ (§6). graceful (CloseMainWindow, как клик по крестику) по
  // умолчанию; force — жёсткий kill (теряет несохранённое) → confirm. НИКОГДА не закрывает сам
  // Джарвис/критические процессы (self-exclusion в актуаторе). Закрытие НЕ через Alt+F4.
  | { kind: "app.close"; app: string; force?: boolean }
  | { kind: "browser.open"; url: string; inDefault?: boolean } // inDefault: открыть в ДЕФОЛТНОМ (залогиненном) браузере пользователя через shell (не CDP-инстанс) — для «просто открой/включи»
  | {
      kind: "browser.act";
      // CDP-драйв: медиа/прокрутка/навигация/клик/ввод по видимому тексту или селектору.
      intent: "play" | "pause" | "next" | "prev" | "scroll" | "click" | "type" | "back" | "forward";
      params?: Record<string, unknown>; // text/selector/dy в зависимости от intent
    }
  | { kind: "browser.read"; selectorIntent: string } // извлечь читаемый контент страницы
  | { kind: "code.run"; lang: CodeLang; code: string } // ограничения §6 обязательны
  | {
      kind: "skill.execute";
      skillId: string;
      version: number;
      steps: SkillStep[];
      params?: Record<string, unknown>;
    } // клиентский skill-runner, §8
  // §Волна2 (2.3): rect — кроп региона (координаты ПОСЛЕДНЕГО полного снимка; space:"screen" = DIP
  // virtual-desktop); scale — доп. масштаб кропа (1 = как есть). Сверка кнопки ~50-200 ток вместо 2K.
  | { kind: "screen.capture"; monitor?: string | number; rect?: ScreenRect; scale?: number } // monitor: "active"(дефолт, под курсором)|"primary"|"jarvis"|индекс
  // §Волна2 (2.3): локальный OCR (Windows.Media.Ocr в сайдкаре) — текст с canvas/игр БЕЗ vision-раунда.
  | { kind: "screen.ocr"; monitor?: string | number; rect?: ScreenRect; lang?: string }
  // §Волна2 (2.3): $0-проба «изменилось ли» — перцептивный хеш региона (сравнивать между вызовами).
  | { kind: "screen.probe"; rect?: ScreenRect; monitor?: string | number }
  // §Волна2 (2.3): клиентское ОЖИДАНИЕ события без LLM-поллинга — один tool-вызов вместо N vision-раундов.
  | { kind: "wait.for"; condition: WaitCondition; timeoutMs?: number; pollMs?: number }
  | { kind: "context.read"; scope: "selection" | "active_window" | "screen" } // дейксис, §19
  | { kind: "demo.record"; op: "start" | "stop" } // обучение демонстрацией, §8
  | { kind: "message.send"; channel: MessageChannel; to: string; body: string } // ТРЕБУЕТ confirm + cadence guard
  // НЕВИДИМО через выделенный Chrome+CDP (НЕ MTProto/userbot — см. message.send). preferredTitle/hintPeerId —
  // опытная память: открыть чат СРАЗУ по запомненному резолву (fast-path), минуя поиск+дизамбигуацию.
  | { kind: "telegram.send"; to: string; text: string; preferredTitle?: string; hintPeerId?: string }
  | { kind: "telegram.read"; to: string; count?: number; preferredTitle?: string; hintPeerId?: string }
  // ── «Браузер Джарвиса» (§6): его СОБСТВЕННЫЙ невидимый залогиненный Chrome, общие примитивы ──
  | { kind: "jbrowser.open"; url: string } // открыть URL в браузере Джарвиса (невидимо) → читаемый контент
  | { kind: "jbrowser.read" } // прочитать текущую страницу браузера Джарвиса
  | { kind: "jbrowser.inspect"; query?: string; cap?: number } // инвентарь интерактивных элементов (глаза на любой сайт)
  | { kind: "jbrowser.act"; intent: "click" | "type" | "scroll" | "key"; params?: Record<string, unknown> }
  | { kind: "jbrowser.login"; url: string } // открыть страницу ВИДИМО для входа (тот же профиль) → дальше невидимо
  | { kind: "jbrowser.import_cookies"; cookies: Array<Record<string, unknown>> } // §перенос логинов: куки из расширения → браузер Джарвиса (CDP setCookie)
  | { kind: "order.place"; vendor: string; items: Record<string, unknown>[]; total: number } // confirm + spend cap + idempotency
  // ── Файловая система (§6): прямое управление файлами на машине пользователя ──
  | { kind: "fs.read"; path: string; maxBytes?: number } // прочитать текстовый файл
  | { kind: "fs.write"; path: string; content: string; createDirs?: boolean } // создать/перезаписать (правка файла)
  | { kind: "fs.edit"; path: string; old: string; new: string; replaceAll?: boolean } // точечная правка: заменить фрагмент (без перезаписи всего файла)
  | { kind: "fs.append"; path: string; content: string } // дописать в конец
  | { kind: "fs.list"; path: string; recursive?: boolean } // содержимое каталога
  | { kind: "fs.delete"; path: string; recursive?: boolean } // удалить файл/каталог — ТРЕБУЕТ confirm (§4)
  | { kind: "fs.move"; from: string; to: string } // переместить/переименовать
  | { kind: "fs.mkdir"; path: string } // создать каталог (рекурсивно)
  | { kind: "fs.search"; root: string; query: string; inContent?: boolean; maxResults?: number } // поиск по имени/содержимому
  // ── Системное управление (§6): питание, блокировка, медиа, громкость, буфер ──
  | { kind: "system.lock" } // заблокировать рабочую станцию (безопасно/обратимо)
  | { kind: "system.power"; op: PowerOp } // sleep/shutdown/restart/logoff — необратимые → confirm (§4)
  | { kind: "system.media"; op: MediaOp } // глобальные media-клавиши
  | { kind: "system.volume"; op: VolumeOp; level?: number } // громкость (set требует level 0..100)
  | { kind: "system.clipboard"; op: "read" | "write"; text?: string } // буфер обмена
  | { kind: "system.layout"; lang: "ru" | "en" | "toggle" } // переключить раскладку клавиатуры активного окна (игры/консоль/ввод)
  // ── Мультимонитор (§6): на какой монитор уводить видимую активность Джарвиса ──
  | { kind: "monitor.set"; target: "jarvis" | "primary" } // ВРЕМЕННО: jarvis=рабочий, primary=основной пользователя
  | { kind: "monitor.list" } // перечислить мониторы (для выбора рабочего)
  | { kind: "monitor.assign"; index: number | null } // ПЕРСИСТЕНТНО назначить рабочий монитор Джарвиса (null=авто)
  // ── Office как ЖИВЫЕ приложения (§6): Word/Excel через COM ──
  | {
      kind: "office.excel";
      op: ExcelOp;
      path: string;
      sheet?: string; // имя листа (по умолчанию активный/первый)
      range?: string; // для read: "A1:C10" (пусто = used range)
      cell?: string; // для write_cell: "B2"
      value?: string; // для write_cell
      row?: string[]; // для append_row: значения новой строки
    }
  | {
      kind: "office.word";
      op: WordOp;
      path: string;
      text?: string; // для write (заменить) / append (дописать абзац)
    }
  // ── OBS Studio через obs-websocket v5 (§): ПРОГРАММНОЕ управление вместо хрупких кликов ──
  | { kind: "obs.request"; requestType: string; requestData?: Record<string, unknown> }; // напр. SetStreamServiceSettings

export type ActionKind = ActionCommand["kind"];

/** Описание одного монитора для выбора рабочего экрана Джарвиса (§6 мультимонитор). */
export interface MonitorInfo {
  /** Индекс в screen.getAllDisplays() — им же назначается рабочий монитор. */
  index: number;
  /** Человеко-метка: «Монитор 1 — 1920×1080 (основной, слева)». */
  label: string;
  width: number;
  height: number;
  /** Основной монитор ОС (там пользователь). */
  isPrimary: boolean;
  /** Текущий рабочий монитор Джарвиса (куда уходят его окна). */
  isJarvis: boolean;
}

/** Список мониторов + текущая настройка (для UI и автономного выбора). */
export interface MonitorList {
  monitors: MonitorInfo[];
  /** Настроенный индекс рабочего монитора Джарвиса; null = авто (вторичный). */
  jarvisIndex: number | null;
}

/**
 * Распарсенный шаг SKILL.md (derived из content_md, §8).
 * needsLlm=true — единственный случай, когда runner зовёт сервер не по ошибке
 * (сочинить текст по месту).
 * expect — постусловие шага: runner поллит до наступления (auto-wait); по таймауту — re-ground +
 * retry; исчерпал retries — эскалация. kind="a11y" (дефолт) — проверка по UIA (role/name/state).
 * kind="visual" — для поверхностей БЕЗ a11y (canvas/игры/видео): сверка по ЭКРАНУ (text — что должно
 * появиться). Локальной OCR-проверки visual пока нет → честная эскалация к LLM (он видит screen_capture),
 * НЕ ложный успех. Шаг без expect — слепой клик (только где постусловие невыразимо).
 */
export interface SkillStep {
  /** ActionKind или верхнеуровневый интент шага ("ground", "verify", ...). */
  action: string;
  target?: Target;
  params?: Record<string, unknown>;
  needsLlm?: boolean;
  /**
   * §Волна3 (3.3, паттерн UFO2): ПРЕДУСЛОВИЕ шага — живой стейт проверяется ПЕРЕД исполнением
   * (элемент существует в UIA / окно открыто). Mismatch → стоп берста/реплея с честным частичным
   * результатом (шаги не бьются вслепую по изменившемуся экрану), один репланинг-раунд у модели.
   */
  precondition?: { role: string; name?: string; nameMode?: "exact" | "substring" };
  expect?: {
    /** Способ проверки: "a11y" (UIA, дефолт) | "visual" (по экрану — для canvas/игр/видео). */
    kind?: "a11y" | "visual";
    role?: string;
    name?: string;
    state?: string;
    /** Для kind="visual": что должно появиться на экране (текст для OCR/сверки глазами). */
    text?: string;
  };
  timeoutMs?: number;
  retries?: number;
}

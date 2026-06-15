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
  | { by: "coords"; x: number; y: number }; // fallback only — vision-координаты

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

/** Операции питания ОС. shutdown/restart/logoff необратимы → confirm (§4). */
export type PowerOp = "sleep" | "shutdown" | "restart" | "logoff";

/** Управление медиа (глобальные media-клавиши). */
export type MediaOp = "play" | "pause" | "next" | "prev" | "stop";

/** Управление громкостью. set требует level (0..100). */
export type VolumeOp = "set" | "mute" | "up" | "down";

/** Операции Excel (через COM). */
export type ExcelOp = "read" | "write_cell" | "append_row";

/** Операции Word (через COM). */
export type WordOp = "read" | "write" | "append";

/**
 * Абстрактная команда действия (server -> client).
 * Конверт: envelope.id = commandId; payload несёт timeoutMs (§5).
 */
export type ActionCommand =
  | { kind: "input.type"; text: string }
  | {
      kind: "input.key";
      combo: string; // "Ctrl+S", "ArrowRight", "Space", "W"
      mode?: "press" | "down" | "up"; // press (по умолч.), down (удержать), up (отпустить) — для игр
      scancode?: boolean; // true → слать сканкодами (DirectInput/RawInput игр)
    }
  | { kind: "input.click"; target: Target } // синтетический ввод — FALLBACK (§6)
  | { kind: "ui.invoke"; target: Target; pattern: UiPattern; value?: string } // UIA-паттерны — ОСНОВНОЙ путь
  | { kind: "ui.ground"; query: { role: string; name?: string } } // -> возвращает handle/bbox в ActionResult.data
  | { kind: "app.launch"; app: string }
  | { kind: "app.focus"; app: string }
  | { kind: "browser.open"; url: string }
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
  | { kind: "screen.capture" }
  | { kind: "context.read"; scope: "selection" | "active_window" | "screen" } // дейксис, §19
  | { kind: "demo.record"; op: "start" | "stop" } // обучение демонстрацией, §8
  | { kind: "message.send"; channel: MessageChannel; to: string; body: string } // ТРЕБУЕТ confirm + cadence guard
  | { kind: "telegram.send"; to: string; text: string } // НЕВИДИМО через выделенный Chrome+CDP (НЕ MTProto/userbot — см. message.send)
  | { kind: "telegram.read"; to: string; count?: number } // прочитать последние сообщения чата
  // ── «Браузер Джарвиса» (§6): его СОБСТВЕННЫЙ невидимый залогиненный Chrome, общие примитивы ──
  | { kind: "jbrowser.open"; url: string } // открыть URL в браузере Джарвиса (невидимо) → читаемый контент
  | { kind: "jbrowser.read" } // прочитать текущую страницу браузера Джарвиса
  | { kind: "jbrowser.act"; intent: "click" | "type" | "scroll" | "key"; params?: Record<string, unknown> }
  | { kind: "order.place"; vendor: string; items: Record<string, unknown>[]; total: number } // confirm + spend cap + idempotency
  // ── Файловая система (§6): прямое управление файлами на машине пользователя ──
  | { kind: "fs.read"; path: string; maxBytes?: number } // прочитать текстовый файл
  | { kind: "fs.write"; path: string; content: string; createDirs?: boolean } // создать/перезаписать (правка файла)
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
  // ── Мультимонитор (§6): на какой монитор уводить видимую активность Джарвиса ──
  | { kind: "monitor.set"; target: "jarvis" | "primary" } // jarvis=рабочий (вторичный), primary=основной пользователя
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
    };

export type ActionKind = ActionCommand["kind"];

/**
 * Распарсенный шаг SKILL.md (derived из content_md, §8).
 * needsLlm=true — единственный случай, когда runner зовёт сервер не по ошибке
 * (сочинить текст по месту).
 * expect — постусловие шага: runner поллит a11y до наступления (auto-wait);
 * по таймауту — re-ground + retry; исчерпал retries — эскалация.
 * Шаг без expect — слепой клик; допустим только там, где постусловие
 * невыразимо (видео-канвас).
 */
export interface SkillStep {
  /** ActionKind или верхнеуровневый интент шага ("ground", "verify", ...). */
  action: string;
  target?: Target;
  params?: Record<string, unknown>;
  needsLlm?: boolean;
  expect?: { role?: string; name?: string; state?: string };
  timeoutMs?: number;
  retries?: number;
}

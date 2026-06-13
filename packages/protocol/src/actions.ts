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

/**
 * Абстрактная команда действия (server -> client).
 * Конверт: envelope.id = commandId; payload несёт timeoutMs (§5).
 */
export type ActionCommand =
  | { kind: "input.type"; text: string }
  | { kind: "input.key"; combo: string } // "Ctrl+S", "ArrowRight", "Space"
  | { kind: "input.click"; target: Target } // синтетический ввод — FALLBACK (§6)
  | { kind: "ui.invoke"; target: Target; pattern: UiPattern; value?: string } // UIA-паттерны — ОСНОВНОЙ путь
  | { kind: "ui.ground"; query: { role: string; name?: string } } // -> возвращает handle/bbox в ActionResult.data
  | { kind: "app.launch"; app: string }
  | { kind: "app.focus"; app: string }
  | { kind: "browser.open"; url: string }
  | { kind: "browser.act"; intent: "play" | "next" | "scroll" | "pause"; params?: Record<string, unknown> } // hak-browser
  | { kind: "browser.read"; selectorIntent: string } // извлечь контент
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
  | { kind: "order.place"; vendor: string; items: Record<string, unknown>[]; total: number }; // confirm + spend cap + idempotency

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

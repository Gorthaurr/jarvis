import type { ActionCommand, ActionResult } from "@jarvis/protocol";

// ───────────────────────── FakeDesktop ─────────────────────────

/** Обработчик ОДНОЙ команды клиенту. Обязан вернуть РОВНО один ActionResult с commandId = meta.commandId. */
export type ActionHandler = (cmd: ActionCommand, meta: { commandId: string; timeoutMs: number }) => Promise<ActionResult>;

/** Запись журнала эффектов: что ФАКТИЧЕСКИ произошло на «ПК» (для проверок по факту, а не по словам модели). */
export interface DesktopEffect {
  /** Монотонный номер эффекта в этом прогоне. */
  n: number;
  /** Виртуальные часы FakeDesktop (мс). */
  at: number;
  /** app.launch | app.close | window.focus | input.type | input.key | input.click | clipboard.write | fs.write | fs.delete | ... */
  kind: string;
  detail: Record<string, unknown>;
}

export interface DesktopWindow {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  /** Текст, набранный в окно (для проверки «напечатал»). */
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  monitor: number;
  minimized: boolean;
}

export interface DesktopSnapshot {
  windows: DesktopWindow[];
  foregroundHwnd: number | null;
  clipboard: string;
  /** Файлы песочницы: путь (нормализованный, с /) → содержимое (utf8) или { binary: bytes }. */
  files: Record<string, string | { binary: number }>;
  volume: number;
  muted: boolean;
  media: { playing: boolean; title?: string };
  locked: boolean;
  /** Запущенные процессы (имя → сколько окон/экземпляров). */
  processes: Record<string, number>;
  effects: DesktopEffect[];
}

/** Начальное состояние прогона. Всё необязательное: по умолчанию — типовой рабочий стол Windows (Проводник, Chrome, ...). */
export interface DesktopSeed {
  windows?: Array<Partial<DesktopWindow> & { title: string; process: string }>;
  files?: Record<string, string>;
  clipboard?: string;
  volume?: number;
  /** Приложения, которые «установлены» и запускаются по имени (иначе app.launch → not_found). */
  installedApps?: string[];
  /** Сеть: адрес → HTML/текст (для невидимого браузера/поиска в лаборатории; пусто — оффлайн). */
  web?: Record<string, string>;
}

export interface FakeDesktop {
  /** Ответить на команду сервера (то, что сделал бы клиент). */
  handle: ActionHandler;
  snapshot(): DesktopSnapshot;
  reset(seed?: DesktopSeed): void;
  /** Виртуальные часы: продвинуть (wait_for, таймеры, «время суток» в контексте). */
  advance(ms: number): void;
  /** Внешнее событие: «владелец» сам двинул мышь / закрыл окно (для сценариев takeover). */
  userAction(kind: string, detail?: Record<string, unknown>): void;
  /** Подписка на эффекты (для eval-предикатов ожидания). */
  onEffect(cb: (e: DesktopEffect) => void): () => void;
}

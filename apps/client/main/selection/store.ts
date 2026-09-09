/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ (2026-09-03) — состояние «что сейчас обведено владельцем» и «идёт ли рисование».
 *
 * Отдельный чистый модуль БЕЗ Electron: рамку рисует окно-оверлей, кадр снимает актуатор, а ЗДЕСЬ
 * живёт только факт «область такая-то, обведена тогда-то» и флаг «вуаль сейчас на экране». Так
 * состояние тестируемо без Electron и у него один владелец (SRP): хоткей, голосовая команда,
 * актуатор И ТОЧКА ИНЖЕКЦИИ ВВОДА (input.ts) ходят сюда, а не хранят свои копии — иначе рамка на
 * экране и то, на что смотрит Джарвис, разъезжаются.
 *
 * ЧЕСТНОСТЬ: выделения нет — значит его НЕТ (null), а не «пустой прямоугольник». Потребитель обязан
 * сказать владельцу «вы ничего не выделяли», а не показать модели случайный кусок экрана.
 */
import type { ScreenSelection } from "@jarvis/protocol";

/** Меньше этого по любой стороне (DIP) — это промах мышью, а не выделение. */
export const MIN_SIDE_DIP = 8;

export type SelectionListener = (s: ScreenSelection | null) => void;

/** Целые DIP + положительные стороны: рамка рисуется мышью, координаты приходят дробными. */
export function normalizeSelection(raw: {
  x: number;
  y: number;
  w: number;
  h: number;
  monitorIndex: number;
  monitor?: string;
  createdAt?: number;
  hash?: string;
}): ScreenSelection | null {
  const x = Math.round(raw.x);
  const y = Math.round(raw.y);
  const w = Math.round(raw.w);
  const h = Math.round(raw.h);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < MIN_SIDE_DIP || h < MIN_SIDE_DIP) return null;
  const out: ScreenSelection = { x, y, w, h, monitorIndex: Math.max(0, Math.round(raw.monitorIndex)) };
  if (raw.monitor) out.monitor = raw.monitor;
  if (typeof raw.createdAt === "number") out.createdAt = raw.createdAt;
  if (raw.hash) out.hash = raw.hash;
  return out;
}

/** Границы монитора в DIP — ровно то, что отдаёт Electron display.bounds (порядок = getAllDisplays). */
export interface MonitorBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * ОСИРОТЕЛО ЛИ выделение после смены конфигурации мониторов (монитор отключили, поменяли разрешение,
 * переставили экраны). Осиротевшие координаты — тихая ложь: рамки на экране уже нет, а промпт всё ещё
 * утверждает «владелец показывает сюда», и Джарвис уверенно опишет чужой экран.
 */
export function selectionOrphaned(sel: ScreenSelection | null, displays: readonly MonitorBounds[]): boolean {
  if (!sel) return false;
  const d = displays[sel.monitorIndex];
  if (!d) return true; // монитора с таким индексом больше нет
  // Область должна ЦЕЛИКОМ лежать на своём мониторе: сдвиг экранов или смена разрешения уводит её вбок.
  return sel.x < d.x || sel.y < d.y || sel.x + sel.w > d.x + d.width || sel.y + sel.h > d.y + d.height;
}

export class SelectionStore {
  private current: ScreenSelection | null = null;
  private listeners = new Set<SelectionListener>();
  /** Контроль-9: подписчики на СМЕНУ фазы рисования (транспорт шлёт её серверу, ввод отпускает удержания). */
  private drawListeners = new Set<(on: boolean) => void>();
  /**
   * Контроль-9 (window-list-drops-own-window-always): HWND окон ВУАЛИ, зарегистрированные самим оверлеем.
   * Раньше `window.list` резал ВСЕ окна нашего процесса — вместе с окнами вуали исчезало ГЛАВНОЕ окно Джарвиса
   * (один и тот же pid), и «перенеси окно Джарвиса на второй монитор» отвечало «окна нет среди открытых».
   */
  private overlayHwnds = new Set<number>();
  /** Момент, когда открылась фаза рисования (вуаль на экране ловит мышь); null = не рисуем. */
  private drawStartedAt: number | null = null;
  /** Когда вуаль закрылась в последний раз (контроль-4: кадр, снятый ПОД вуалью, помечается и если она закрылась до возврата). */
  private drawEndedAt: number | null = null;

  get(): ScreenSelection | null {
    return this.current;
  }

  get active(): boolean {
    return this.current !== null;
  }

  /** Вуаль режима рисования сейчас на экране (ловит мышь на всех мониторах). */
  get drawing(): boolean {
    return this.drawStartedAt !== null;
  }

  /** Отметить начало/конец фазы рисования — ставит ТОЛЬКО оверлей (единственный владелец окон). */
  setDrawing(on: boolean, now = Date.now()): void {
    const was = this.drawStartedAt !== null;
    if (!on && this.drawStartedAt !== null) this.drawEndedAt = now;
    this.drawStartedAt = on ? (this.drawStartedAt ?? now) : null;
    if (was === (this.drawStartedAt !== null)) return;
    for (const l of this.drawListeners) {
      try {
        l(on);
      } catch {
        /* подписчик (транспорт/ввод) не должен ронять смену фазы */
      }
    }
  }

  /** Подписка на смену фазы рисования. Возвращает отписку. */
  onDrawingChange(l: (on: boolean) => void): () => void {
    this.drawListeners.add(l);
    return () => this.drawListeners.delete(l);
  }

  /** Оверлей регистрирует СВОИ окна: только они не должны выдаваться за состояние системы владельца. */
  registerOverlayWindow(hwnd: number): void {
    if (Number.isFinite(hwnd) && hwnd !== 0) this.overlayHwnds.add(hwnd);
  }

  unregisterOverlayWindow(hwnd: number): void {
    this.overlayHwnds.delete(hwnd);
  }

  isOverlayWindow(hwnd: number): boolean {
    return this.overlayHwnds.has(hwnd);
  }

  /** Вуаль закрылась ПОЗЖЕ момента t — значит, она перекрывала команду, начатую в t (даже если уже закрыта). Строго: закрылась в t = команда шла уже без вуали. */
  drawingEndedAfter(t: number): boolean {
    return this.drawEndedAt !== null && this.drawEndedAt > t;
  }

  /**
   * Почему ФИЗИЧЕСКИЙ ввод сейчас нельзя инжектить (null = можно). Формулировка о СОСТОЯНИИ
   * СИСТЕМЫ («открыт оверлей»), а не о действии владельца («он прямо сейчас обводит»): оверлей мог
   * открыть и сам Джарвис, а владелец — отойти; выдуманное действие человека — тот класс дефектов,
   * что разбирали на «Доте» (USER_BUSY). Одна точка правды для dispatch, реплея навыка и SDK-моста.
   */
  physicalInputBlockReason(now = Date.now()): string | null {
    if (this.drawStartedAt === null) return null;
    const sec = Math.max(0, Math.round((now - this.drawStartedAt) / 1000));
    return (
      `Поверх экрана открыт оверлей режима выделения (уже ${sec} с; ждём, обведёт ли владелец область — ` +
      "закроется по Esc или сам по таймауту). Физический клик/ввод попал бы в него, а не в цель. " +
      "Это НЕ «пользователь занят»: дождись закрытия оверлея и повтори, либо действуй путём, не трогающим " +
      "мышь (browser_act/web_act/code_run/ui_invoke). Работу с себя не снимай."
    );
  }

  /** Возраст выделения в мс по часам КЛИЕНТА (нет выделения/времени → null, а не 0). */
  ageMs(now: number): number | null {
    const t = this.current?.createdAt;
    if (typeof t !== "number") return null;
    return Math.max(0, now - t);
  }

  /** Принять выделение (уже нормализованное). null — снять. Молча одинаковое не переотправляем. */
  set(next: ScreenSelection | null): void {
    if (same(this.current, next)) return;
    this.current = next;
    for (const l of this.listeners) {
      try {
        l(next);
      } catch {
        /* подписчик (транспорт/оверлей) не должен ронять смену состояния */
      }
    }
  }

  clear(): void {
    this.set(null);
  }

  /** Дополнить текущее выделение отпечатком содержимого (проба снимается асинхронно, после фиксации). */
  attachHash(hash: string): void {
    if (!this.current || this.current.hash === hash) return;
    this.current = { ...this.current, hash };
  }

  onChange(l: SelectionListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

function same(a: ScreenSelection | null, b: ScreenSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.monitorIndex === b.monitorIndex && a.createdAt === b.createdAt;
}

/** Синглтон на main-процесс: экран один, и владелец его хозяин. */
export const selectionStore = new SelectionStore();

/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ (2026-09-03) — прозрачные окна-оверлеи, которыми владелец обводит кусок экрана.
 *
 * Устройство (и почему так):
 *  • ПО ОКНУ НА КАЖДЫЙ МОНИТОР, а не одно на весь виртуальный десктоп: на Windows окно, растянутое на
 *    мониторы с разным масштабом, рендерится в чужом DPI и координаты рамки уезжают. Окно = bounds
 *    своего дисплея, поэтому CSS-пиксель внутри окна = DIP этого монитора, а экранная координата =
 *    bounds.x + локальная.
 *  • ФАЗА РИСОВАНИЯ — окна принимают мышь; ФАЗА РАМКИ — остаётся одно окно на мониторе выделения,
 *    оно click-through (setIgnoreMouseEvents), не фокусируемо и не в панели задач: владелец
 *    продолжает работать, рамка просто висит.
 *  • setContentProtection(true) стоит, но ЗАМЕРЕНО (смоук 2026-09-05, Win10 19045 / Electron 33):
 *    на ПРОЗРАЧНОМ окне оно рамку из собственного desktopCapturer НЕ исключает (display affinity не
 *    действует на layered-окна, а transparent:true в Electron — именно оно). Значит полный
 *    screen_capture рамку ВИДИТ. Поэтому настоящая защита — по построению: рамка рисуется СНАРУЖИ
 *    выделенной области, без свечения и без текста, и кроп самого выделения (`view`) остаётся чистым.
 *    Не «чинить» это скрытием окна на время захвата: сенсоры (OCR/probe/observe) снимают экран
 *    постоянно, и рамка мигала бы у владельца на каждом их кадре.
 *
 * АДВЕРС-РЕВЬЮ 2026-09-05 (закрыто здесь):
 *  • start() был разрушительно реентерабелен: второй start (модельный `screen_selection{op:"start"}`
 *    через 2–5 с латентности, STT-дубль «выдели область») убивал окна ПОСРЕДИ протяжки, стирал прежнее
 *    выделение и рапортовал первому вызывающему ложное «владелец отменил». Теперь повторный start
 *    ПРИСОЕДИНЯЕТСЯ к идущему рисованию (список резолверов, один исход всем).
 *  • Провал открытия окон читался как «владелец отменил» → отдельный исход `failed` (система, не человек).
 *  • Фаза рисования жила бессрочно и всё это время гейт физического ввода утверждал «владелец прямо
 *    сейчас обводит» → таймаут `JARVIS_SELECTION_DRAW_TIMEOUT_MS` (деф 120 с) с исходом
 *    `cancelled{reason:"timeout"}`, который прежнее выделение НЕ трогает.
 *  • Прежняя рамка больше не гасится на старте рисования: она исчезает только когда есть НОВЫЙ исход.
 *
 * ⚠️ ЧЕСТНЫЙ ПРЕДЕЛ: поверх ИСКЛЮЧИТЕЛЬНОГО полноэкранного режима (exclusive fullscreen у игр) оверлея
 * не видно — это ограничение Windows, а не наш сбой. В borderless windowed (обычный режим современных
 * игр) рамка видна.
 */
import { BrowserWindow, screen, type Display } from "electron";
import { join } from "node:path";
import { createLogger } from "@jarvis/shared";
import { monitors } from "../monitors.js";
import { normalizeSelection, selectionStore } from "./store.js";
import { type OverlayRect, clipToWindow } from "./geometry.js";
import type { ScreenSelection } from "@jarvis/protocol";

const log = createLogger("selection:overlay");

/** Сколько ждём владельца с открытой вуалью, прежде чем честно закрыть её самим. */
export function drawTimeoutMs(): number {
  const n = Number.parseInt(process.env.JARVIS_SELECTION_DRAW_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n >= 5_000 ? n : 120_000;
}

export type CancelReason = "esc" | "timeout" | "cleared" | "quit";

export interface OverlayOutcome {
  selection?: ScreenSelection;
  /** Рисование закрылось без области. reason говорит, КТО закрыл: владелец (esc) или система. */
  cancelled?: boolean;
  reason?: CancelReason;
  /** Окна оверлея не открылись — сбой СИСТЕМЫ, к владельцу отношения не имеет. */
  failed?: boolean;
  /** Чем именно: окна не создались вовсе / открылись, но рендерер упал (серверу — по факту, не «не создались»). */
  failReason?: "no-windows" | "crashed";
}

type Resolver = (o: OverlayOutcome) => void;

export class SelectionOverlay {
  private drawWins = new Map<number, BrowserWindow>(); // webContents.id → окно фазы рисования
  private frameWin: BrowserWindow | null = null;
  /** Все, кто ждёт исхода ТЕКУЩЕГО рисования: повторный start присоединяется, а не перезапускает. */
  private waiters: Resolver[] = [];
  private drawTimer: NodeJS.Timeout | null = null;
  /** finishDraw уничтожает окна в цикле — их 'closed' не должны запускать второй finishDraw. */
  private finishing = false;

  get drawing(): boolean {
    return this.drawWins.size > 0;
  }

  /**
   * Открыть оверлеи на всех мониторах и ждать, пока владелец обведёт область (или отменит / истечёт
   * время). Если рисование УЖЕ идёт — присоединиться к нему: один исход получат все ожидающие.
   */
  start(): Promise<OverlayOutcome> {
    if (this.drawing) {
      log.info("start во время рисования — присоединяюсь к идущему, окна не трогаю");
      return new Promise<OverlayOutcome>((resolve) => this.waiters.push(resolve));
    }
    return new Promise<OverlayOutcome>((resolve) => {
      this.waiters.push(resolve);
      const cursorDisplay = displayUnderCursor();
      for (const [index, display] of screen.getAllDisplays().entries()) {
        try {
          // Фокус — только окну под курсором: крадём переднее окно один раз, а не столько раз, сколько
          // мониторов; клик на другом мониторе сфокусирует своё окно сам (окна focusable).
          const w = this.createWindow(display, "draw", display.id === cursorDisplay?.id);
          this.drawWins.set(w.webContents.id, w);
          w.webContents.once("did-finish-load", () => w.webContents.send("selection:mode", { mode: "draw", index }));
        } catch (e) {
          log.warn("оверлей не открылся на мониторе", { index, err: e instanceof Error ? e.message : String(e) });
        }
      }
      if (this.drawWins.size === 0) {
        this.finishDraw({ failed: true, failReason: "no-windows" }); // сбой системы — не «владелец отменил»
        return;
      }
      selectionStore.setDrawing(true);
      this.drawTimer = setTimeout(() => {
        log.info("фаза рисования закрыта по таймауту — владелец не обвёл область", { ms: drawTimeoutMs() });
        this.finishDraw({ cancelled: true, reason: "timeout" });
      }, drawTimeoutMs());
      this.drawTimer.unref?.();
    });
  }

  /** Результат от окна-оверлея (main регистрирует IPC и зовёт это). */
  submit(webContentsId: number, rect: OverlayRect | null): void {
    const win = this.drawWins.get(webContentsId);
    if (!win) {
      log.debug("selection:done от окна не из фазы рисования — игнор"); // рамка/уничтоженное окно исход не решают
      return;
    }
    const display = displayOfWindow(win);
    if (!rect || !display || !isFiniteRect(rect)) {
      this.finishDraw({ cancelled: true, reason: "esc" });
      return;
    }
    // Протяжку могли начать здесь, а отпустить на СОСЕДНЕМ мониторе — тогда координаты выходят за окно.
    // Обрезаем по его границам: иначе кроп молча зажался бы в клиенте, и модель увидела бы НЕ то, что обвели.
    const clipped = clipToWindow(rect, display.bounds.width, display.bounds.height);
    const info = monitors.monitorList().monitors[indexOfDisplay(display)];
    const sel = clipped
      ? normalizeSelection({
          x: display.bounds.x + clipped.x,
          y: display.bounds.y + clipped.y,
          w: clipped.w,
          h: clipped.h,
          monitorIndex: indexOfDisplay(display),
          monitor: info?.label,
          createdAt: Date.now(),
        })
      : null;
    // Клик без протяжки / рамка мимо экрана — не выделение: это отмена рукой владельца.
    this.finishDraw(sel ? { selection: sel } : { cancelled: true, reason: "esc" });
  }

  /** Оставить на экране рамку вокруг выделения (click-through, поверх всего). */
  showFrame(sel: ScreenSelection): void {
    this.hideFrame();
    // Дисплей ищем ПО ТОЧКЕ выделения, а не по индексу: порядок getAllDisplays меняется при
    // переподключении монитора, и по старому индексу рамка вылезла бы на чужом экране.
    const display = displayForPoint(sel.x + sel.w / 2, sel.y + sel.h / 2);
    try {
      const w = this.createWindow(display, "frame", false);
      this.frameWin = w;
      w.setIgnoreMouseEvents(true, { forward: false }); // мышь проходит насквозь — владельцу не мешаем
      const local = { x: sel.x - display.bounds.x, y: sel.y - display.bounds.y, w: sel.w, h: sel.h };
      w.webContents.once("did-finish-load", () => w.webContents.send("selection:mode", { mode: "frame", rect: local }));
    } catch (e) {
      log.warn("рамка выделения не показана", e instanceof Error ? e.message : String(e));
      this.frameWin = null;
    }
  }

  hideFrame(): void {
    const w = this.frameWin;
    this.frameWin = null;
    if (w && !w.isDestroyed()) w.destroy();
  }

  /** Снять всё: и фазу рисования (с отменой ожидания), и висящую рамку. */
  hideAll(reason: CancelReason): void {
    if (this.drawing) log.info("выделение прервано", { reason });
    this.finishDraw({ cancelled: true, reason });
    this.hideFrame();
  }

  /**
   * Окно фазы рисования исчезло НЕ через submit: владелец закрыл его Alt+F4 (Windows закрывает фокусное
   * окно штатно — renderer ловит только Esc) или рендерер упал. Без этого `drawing` залипал до таймаута,
   * гейт ввода отвечал «открыт оверлей» при пустом экране, а повторный start присоединялся к мёртвому
   * рисованию (адверс-ревью 2026-09-05, контроль).
   */
  private onDrawWindowGone(webContentsId: number, why: "closed" | "crashed"): void {
    if (this.finishing || !this.drawWins.has(webContentsId)) return;
    this.drawWins.delete(webContentsId);
    // Контроль-3: фаза закрывается для ВСЕХ мониторов сразу. Раньше при двух мониторах Alt+F4 фокусного
    // окна оставлял drawing=true до таймаута: у владельца вуали уже нет, а гейт ввода и view отвечали
    // «идёт рисование» — и его решение «закрыл рукой» не исполнялось. Частичная вуаль после краша —
    // тот же класс. Оставшиеся окна гасит finishDraw.
    log.info("окно рисования исчезло извне — фаза закрыта на всех мониторах", { why, remaining: this.drawWins.size });
    this.finishDraw(why === "crashed" ? { failed: true, failReason: "crashed" } : { cancelled: true, reason: "esc" }); // закрыл рукой = его решение
  }

  /** Единственная точка завершения фазы рисования: закрыть окна, снять флаг, отдать исход ВСЕМ ждущим. */
  private finishDraw(outcome: OverlayOutcome): void {
    if (this.drawTimer) {
      clearTimeout(this.drawTimer);
      this.drawTimer = null;
    }
    this.finishing = true;
    try {
      for (const w of this.drawWins.values()) {
        if (!w.isDestroyed()) w.destroy();
      }
    } finally {
      this.finishing = false;
    }
    this.drawWins.clear();
    selectionStore.setDrawing(false);
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(outcome);
  }

  private createWindow(display: Display, mode: "draw" | "frame", takeFocus: boolean): BrowserWindow {
    const w = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      backgroundColor: "#00000000",
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      // Фаза рамки — окно НЕ фокусируемо (не крадём ввод у игры/редактора); фаза рисования ловит мышь и Esc.
      focusable: mode === "draw",
      show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/overlay.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    // Контроль-9: HWND окна вуали — в реестр, чтобы `window.list` резал ИМЕННО их, а не всё окно-хозяйство
    // нашего процесса (главное окно Джарвиса живёт под тем же pid и обязано оставаться видимым модели).
    try {
      const hwnd = w.getNativeWindowHandle().readUInt32LE(0);
      selectionStore.registerOverlayWindow(hwnd);
      w.once("closed", () => selectionStore.unregisterOverlayWindow(hwnd));
    } catch {
      /* платформа без HWND — фолбэк: список режет окна процесса на время рисования (см. windows.ts) */
    }
    w.setAlwaysOnTop(true, "screen-saver");
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    try {
      w.setContentProtection(true); // на прозрачном окне НЕ работает (замерено) — оставлено на случай непрозрачной сборки
    } catch {
      /* платформа без поддержки — вторая линия: рамка рисуется СНАРУЖИ области */
    }
    w.loadFile(join(__dirname, "../renderer/overlay.html"));
    if (mode === "draw") {
      const id = w.webContents.id;
      w.on("closed", () => this.onDrawWindowGone(id, "closed"));
      w.webContents.on("render-process-gone", () => {
        // Сначала ИСХОД, потом destroy(): destroy() эмитит 'closed' синхронно, и в обратном порядке фаза
        // закрывалась бы как «владелец закрыл» (esc) вместо честного «сбой системы» (failed).
        this.onDrawWindowGone(id, "crashed");
        if (!w.isDestroyed()) w.destroy();
      });
    }
    if (mode === "draw" && takeFocus) {
      w.show();
      w.focus();
    } else {
      w.showInactive(); // не забираем фокус у того, с чем работает владелец
    }
    return w;
  }
}

function isFiniteRect(r: OverlayRect): boolean {
  return [r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n));
}

function displayUnderCursor(): Display | null {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch {
    return null;
  }
}

function displayForPoint(x: number, y: number): Display {
  try {
    return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  } catch {
    return screen.getPrimaryDisplay();
  }
}

function displayOfWindow(w: BrowserWindow): Display | null {
  try {
    const b = w.getBounds();
    return screen.getDisplayNearestPoint({ x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) });
  } catch {
    return null;
  }
}

function indexOfDisplay(d: Display): number {
  const i = screen.getAllDisplays().findIndex((x) => x.id === d.id);
  return i >= 0 ? i : 0;
}

export const selectionOverlay = new SelectionOverlay();

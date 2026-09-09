/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ — проводка между состоянием, ОС и сервером, вынесенная из Electron-entry
 * (контроль-3, 2026-09-05): в `main/index.ts` она жила без единого теста, и «не слать client.selection
 * на смену», «не снимать осиротевшую рамку при отключении монитора», «хоткей во время рисования не
 * гасит вуаль» оставляли прогон зелёным — а сервер утверждал бы «владелец показывает сюда» после того,
 * как монитор с рамкой отключили.
 *
 * Здесь только ЛОГИКА; Electron-примитивы (ipcMain/screen/globalShortcut/transport) приходят снаружи
 * узкими функциями — модуль тестируется на подделках, как overlay.test.ts.
 *
 * Атрибуция отмены (контроль-3): повторный хоткей во время рисования — РУКА ВЛАДЕЛЬЦА (`byOwner`),
 * смена конфигурации мониторов — СИСТЕМА. Сервер по этому признаку говорит модели правду о том, кто
 * закрыл оверлей; раньше оба пути шли одной причиной «cleared», и владельцу приписывали «прервано не вами».
 */
import type { ScreenSelection } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import type { OverlayRect } from "./geometry.js";
import { selectionOrphaned } from "./store.js";

const log = createLogger("selection:wiring");

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionWiringDeps {
  store: {
    onChange(cb: (sel: ScreenSelection | null) => void): unknown;
    /** Контроль-9: смена ФАЗЫ рисования — отдельный факт, сервер узнаёт о ней сразу (browser_open мимо гейта). */
    onDrawingChange(cb: (on: boolean) => void): unknown;
    get(): ScreenSelection | null;
    ageMs(now: number): number | null;
    readonly drawing: boolean;
  };
  overlay: { submit(webContentsId: number, rect: OverlayRect | null): void; readonly drawing: boolean };
  /** Отправить состояние серверу (client.selection). Оффлайн — молча; на connected зовут resendCurrent(). */
  sendSelection(sel: ScreenSelection | null, ageMs: number | null, drawing: boolean): void;
  displays(): DisplayBounds[];
  onDisplaysChanged(cb: (reason: string) => void): void;
  /** IPC «selection:done» от окна-оверлея: (webContents.id, прямоугольник | null). */
  onOverlayDone(cb: (webContentsId: number, rect: OverlayRect | null) => void): void;
  /** globalShortcut.register — true, если клавиша зарегистрирована. Может бросить. */
  registerHotkey(accel: string, cb: () => void): boolean;
  /** Открыть оверлей по воле владельца (хоткей = force). */
  start(): Promise<unknown>;
  /** Снять выделение / погасить вуаль. byOwner — закрыл владелец (хоткей), иначе система. */
  clear(opts: { byOwner: boolean }): unknown;
  /** Акселератор из env; пустая строка — не регистрировать. */
  hotkey: string;
  /** (Ре)коннект к серверу: рамка пережила обрыв — сервер должен узнать о ней с возрастом. */
  onConnected(cb: () => void): void;
  now?: () => number;
}

export interface SelectionWiring {
  /** Зарегистрированная клавиша (null = нет) — уходит серверу в client.env для паспорта возможностей. */
  hotkey: string | null;
  /** Дослать текущее состояние (на (ре)коннекте: рамка пережила обрыв — сервер должен знать о ней с возрастом). */
  resendCurrent(): void;
}

export function wireSelection(d: SelectionWiringDeps): SelectionWiring {
  const now = d.now ?? Date.now;
  d.onOverlayDone((id, rect) => d.overlay.submit(id, rect));
  d.store.onChange((sel) => {
    d.sendSelection(sel, d.store.ageMs(now()), d.store.drawing);
    log.info(sel ? "§выделение: владелец обвёл область" : "§выделение: снято", sel ? { w: sel.w, h: sel.h, monitor: sel.monitorIndex } : {});
  });
  // Конфигурация мониторов сменилась (экран отключили, поменяли разрешение/расположение) — координаты
  // выделения осиротели. Снимаем ЧЕСТНО: сервер тем же подписчиком получит client.selection: null.
  d.onDisplaysChanged((reason) => {
    if (!selectionOrphaned(d.store.get(), d.displays())) return;
    log.info("§выделение снято: конфигурация мониторов изменилась", { reason });
    d.clear({ byOwner: false });
  });

  let hotkey: string | null = null;
  const accel = d.hotkey.trim();
  if (accel) {
    try {
      const ok = d.registerHotkey(accel, () => {
        // Повторное нажатие ВО ВРЕМЯ рисования = передумал: гасим оверлей и снимаем выделение вовсе
        // (иначе «выключить режим» с клавиатуры было бы нечем — Esc внутри окна делает то же самое).
        // Это рука владельца — так и докладываем (byOwner), а не «прервано не владельцем».
        if (d.overlay.drawing) {
          d.clear({ byOwner: true });
          return;
        }
        void Promise.resolve(d.start()).catch((err) => log.warn("режим выделения не открылся", err instanceof Error ? err.message : String(err)));
      });
      if (!ok) log.warn(`§выделение: горячая клавиша ${accel} занята другой программой — работает только голосом`);
      else {
        hotkey = accel;
        log.info(`§выделение: горячая клавиша ${accel} (глобальная — у программ с такой же внутренней привязкой её отберём)`);
      }
    } catch (e) {
      log.warn("§выделение: горячую клавишу зарегистрировать не удалось", e instanceof Error ? e.message : String(e));
    }
  }
  // Контроль-9 (browser-open-ext-bypasses-veil): открылась/закрылась ВУАЛЬ — сервер обязан узнать об этом сразу,
  // иначе `browser_open` через расширение (штатный канал, клиентского гейта не проходит) выведет окно браузера
  // поверх окна рисования и отберёт у владельца Esc.
  d.store.onDrawingChange((on) => {
    d.sendSelection(d.store.get(), d.store.ageMs(now()), on);
    log.info(on ? "§выделение: открылась вуаль рисования" : "§выделение: вуаль рисования закрыта");
  });
  const resendCurrent = (): void => d.sendSelection(d.store.get(), d.store.ageMs(now()), d.store.drawing);
  d.onConnected(resendCurrent);
  return { hotkey, resendCurrent };
}

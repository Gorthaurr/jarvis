/**
 * §Волна2 (2.4) — Окна верхнего уровня через win-сайдкар: список и фокус.
 *
 * window.list — дешёвый on-demand ответ «появилось ли окно» (hwnd/pid/process/title/
 * foreground/minimized) за миллисекунды, без PowerShell и без 12с-таймера снапшота.
 * window.focus — SetForegroundWindow+AttachThreadInput с ЧЕСТНЫМ readback: focused=false
 * означает «фокус реально не взят» (не ложный успех) — вызывающий откатывается на
 * AppActivate (apps.focusApp) или докладывает провал.
 *
 * Если сайдкар не поднят — NotImplementedError (dispatch → runtime-ошибка).
 */
import { createLogger } from "@jarvis/shared";
import { monitors } from "../monitors.js";
import { NotImplementedError } from "./input.js";
import { sidecar } from "./sidecar-client.js";
import { assertNoDrawingOverlay, assertNoOverlayDuring } from "../selection/overlay-error.js";
import { selectionStore } from "../selection/store.js";

const log = createLogger("actuator:windows");

/** Сырое окно от сайдкара: + rect (ФИЗИЧЕСКИЕ пиксели Win32) для привязки к монитору. */
interface RawWindow {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  foreground: boolean;
  minimized: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowInfo {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  foreground: boolean;
  minimized: boolean;
  /** Мультимонитор (2026-07-14): на КАКОМ мониторе окно — индекс СОГЛАСОВАН с screen_capture{monitor}. */
  monitorIndex: number;
  /** Человеко-метка монитора («осн. монитор» / «монитор 2») — для сводки модели. */
  monitor: string;
  /** Физический rect окна (Win32). Нужен window_arrange, чтобы перенос СОХРАНИЛ размер окна. */
  rect: { x: number; y: number; w: number; h: number };
}

export interface WindowFocusResult {
  focused: boolean;
  hwnd: number;
  title: string;
  /** Монитор сфокусированного окна — чтобы screen_capture{monitor} снял ИМЕННО его (не курсорный). */
  monitorIndex?: number;
  monitor?: string;
}

/** Метка монитора окна по его физическому rect (пустой ИЛИ off-screen rect → без монитора).
 *  Свёрнутое окно у Win32 имеет rect {-32000,-32000,…} (IsIconic) — displayForRect дал бы ЛОЖНЫЙ
 *  «ближайший» монитор (ревью #5); координаты ≤ -30000 = off-screen → монитор неопределён. */
function monitorOf(w: { x: number; y: number; w: number; h: number }): { index: number; label: string } | null {
  if (!w.w || !w.h) return null;
  if (w.x <= -30000 || w.y <= -30000) return null; // свёрнутое/off-screen окно — монитора нет
  try {
    const m = monitors.displayForRect({ x: w.x, y: w.y, width: w.w, height: w.h });
    return { index: m.index, label: m.primary ? "осн. монитор" : `монитор ${m.index + 1}` };
  } catch {
    return null;
  }
}

function ensure(): void {
  if (!sidecar().ready) throw new NotImplementedError("сайдкар окон не запущен");
}

/** Перечислить видимые титулованные окна верхнего уровня — с привязкой окно→монитор (мультимонитор). */
export async function listWindows(): Promise<WindowInfo[]> {
  ensure();
  const data = (await sidecar().request("window.list", {}, 8_000)) as { windows?: RawWindow[] };
  // Контроль-8 (window-list-overlay): окна СОБСТВЕННОГО процесса — не состояние системы владельца. В фазе рисования
  // оверлей выделения (по окну на монитор, always-on-top, сфокусировано) попадал в список и получал foreground:true:
  // на «какое окно активно / открылось ли приложение» модель докладывала владельцу окно Джарвиса, а решив, что цель
  // потеряла фокус, звала window_focus — и тут же получала отказ вуали (замкнутый круг). Контроль-7 снял с
  // window.list пометку вуали, но вторую половину — не отдавать СВОИ окна — не сделал.
  // Контроль-9 (window-list-drops-own-window-always): фильтр был безусловным и по PID — вместе с окнами вуали из
  // списка НАВСЕГДА исчезало ГЛАВНОЕ окно Джарвиса (тот же процесс). «Перенеси окно Джарвиса на второй монитор»
  // отвечало «окно не найдено среди открытых», и модель докладывала владельцу выдуманную причину, глядя на
  // собственный отфильтрованный список. Режем ИМЕННО окна вуали (их регистрирует оверлей), а на время фазы
  // рисования — все свои (страховка, если HWND зарегистрировать не удалось; window_arrange тогда и так гейтится).
  // Контроль-10 (listwindows-drops-own-during-drawing): фолбэк «в фазе рисования режем ВСЕ свои окна» делал
  // `wait_for{kind:"window"}` по окну Джарвиса слепым и отвечал ДОСТОВЕРНЫМ «окна нет» (а `window_arrange{minimize}`
  // — единственная незагейченная операция — «окно не найдено»). Признак окна вуали ровно один: его регистрирует
  // сам оверлей.
  const raw = (Array.isArray(data?.windows) ? data.windows : []).filter(
    (w) => !(w.pid === process.pid && selectionStore.isOverlayWindow(w.hwnd)),
  );
  const multi = monitors.hasMultiple;
  return raw.map((w) => {
    // Свёрнутое окно — монитор неопределён (rect off-screen): честно «свёрнуто», не ложный «монитор N».
    const m = w.minimized ? null : monitorOf(w);
    return {
      hwnd: w.hwnd,
      pid: w.pid,
      process: w.process,
      title: w.title,
      foreground: w.foreground,
      minimized: w.minimized,
      // При одном мониторе индекс всегда 0 — не зашумляем; при нескольких — реальная привязка.
      monitorIndex: m?.index ?? 0,
      monitor: w.minimized ? "свёрнуто" : multi ? (m?.label ?? "монитор ?") : "осн. монитор",
      rect: { x: w.x, y: w.y, w: w.w, h: w.h },
    };
  });
}

/**
 * Сфокусировать окно: hwnd (из window.list, точно) или подстрока заголовка/имени процесса.
 * Возвращает честный readback; focused=false НЕ маскируется под успех.
 */
export async function focusWindow(opts: { hwnd?: number; query?: string }): Promise<WindowFocusResult> {
  assertNoDrawingOverlay(); // контроль-6 (SR-C6-1): ДО ensure() — гард достижим и без сайдкара
  ensure();
  if (opts.hwnd === undefined && !opts.query?.trim()) {
    throw new Error("window.focus: нужен hwnd (из window_list) или query (подстрока заголовка/процесса)");
  }
  log.debug("window.focus", opts);
  // Контроль-10 (focus-no-postcheck): внутри RPC сайдкар делает SW_RESTORE + SetForegroundWindow + ALT-нудж — сотни
  // мс реальной инжекции. Вуаль, открывшаяся в этом окне, теряет клавиатуру (Esc владельца уходит в чужое окно), а
  // readback честно рапортует focused:true. Пост-проверка — тот же приём, что у печати/клика/мыши/нажатия клавиши.
  const tFocus = Date.now();
  const data = (await sidecar().request("window.focus", { hwnd: opts.hwnd, query: opts.query }, 8_000)) as WindowFocusResult & {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  };
  assertNoOverlayDuring(tFocus, "Смена фокуса окна");
  const m = monitorOf({ x: data?.x ?? 0, y: data?.y ?? 0, w: data?.w ?? 0, h: data?.h ?? 0 });
  return {
    focused: Boolean(data?.focused),
    hwnd: Number(data?.hwnd ?? 0),
    title: String(data?.title ?? ""),
    monitorIndex: m?.index,
    monitor: monitors.hasMultiple ? m?.label : undefined,
  };
}

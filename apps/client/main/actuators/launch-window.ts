/**
 * W2 (П4, G-20): после app.launch ДОЖДАТЬСЯ окна запущенного — «процесс стартовал» ещё не «программа готова».
 * Модель сразу шла act'ом в окно, которого не было (Steam грузится секундами, UWP-Блокнот отдаёт окно другому процессу),
 * и клик уходил в то, что было на переднем плане.
 *
 * Как узнаём окно (window.list — z-порядок сверху вниз, с pid/hwnd):
 *  - окно процесса с pid запуска;
 *  - иначе окно, которого ДО запуска не было или которое стало передним (лаунчер / UWP-стаб / уже запущенная копия
 *    с другим pid отдают окно своему процессу): из таких — переднее;
 *  - иначе окно процесса с именем запущенного (новое, затем уже открытое).
 * Итог: `window{hwnd,title}` или `windowSeen:false` (за 5 с не появилось — может ещё грузиться). Сайдкар не ответил ни
 * разу — НИЧЕГО не утверждаем (ни окна, ни «не видно»). Свои окна (Джарвис, вуаль) не считаются.
 * Бюджет: снимок до ≤ 1,5 с + лаунчер ≤ 25 с + ожидание ≤ 5 с (+ последний опрос) < 36 с серверного окна app.launch.
 */
import type { AppLaunchWindow } from "@jarvis/protocol";
export type { AppLaunchWindow };
import { sleep } from "@jarvis/shared";
import { sidecar } from "./sidecar-client.js";

export const LAUNCH_WINDOW_WAIT_MS = 5_000;
const POLL_MS = 250;
const LIST_TIMEOUT_MS = 1_500;

interface RawWindow {
  hwnd: number;
  pid: number;
  process?: string;
  title: string;
  foreground?: boolean;
}

/** Окна верхнего уровня без своих; null — сайдкар не ответил. */
async function listWindowsRaw(): Promise<RawWindow[] | null> {
  try {
    if (!sidecar().ready) return null;
    const d = (await sidecar().request("window.list", {}, LIST_TIMEOUT_MS)) as { windows?: RawWindow[] };
    return Array.isArray(d?.windows) ? d.windows.filter((w) => w.pid !== process.pid) : null;
  } catch {
    return null;
  }
}

/** Снимок «до»: hwnd → был ли передним. */
export type WindowsBefore = ReadonlyMap<number, boolean>;

const exeName = (s: string): string => (s.split(/[\\/]/u).pop() ?? s).replace(/\.exe$/iu, "").trim().toLowerCase();

/** Окно запуска в снимке «после» (ЧИСТАЯ функция). */
export function pickLaunchWindow(after: readonly RawWindow[], before: WindowsBefore, pid: number | undefined, target: string): RawWindow | null {
  if (pid) {
    const own = after.find((w) => w.pid === pid);
    if (own) return own;
  }
  const changed = after.filter((w) => !before.has(w.hwnd) || (w.foreground === true && before.get(w.hwnd) === false));
  const fg = changed.find((w) => w.foreground === true);
  if (fg) return fg;
  // По имени процесса: новое окно, иначе уже открытое (копия уже работала и уже была впереди — окно программы есть).
  const name = exeName(target);
  const same = (w: RawWindow): boolean => Boolean(name) && exeName(w.process ?? "") === name;
  return changed.find(same) ?? after.find(same) ?? null;
}

/** Пояснение модели к `windowSeen:false` (окно есть или сайдкар молчал — пояснять нечего). */
export function launchWindowNote(r: AppLaunchWindow): string | undefined {
  return r.windowSeen === false ? `окно за ${LAUNCH_WINDOW_WAIT_MS / 1000} с не появилось (программа может ещё грузиться) — сверь window_list/wait_for перед действиями в нём.` : undefined;
}

/**
 * Запустить и дождаться окна. Веб-адрес (фолбэк browser.open) окна не ждёт: вкладка в уже открытом браузере
 * нового окна не даёт — ждали бы впустую 5 с.
 */
export async function withLaunchWindow<T extends { pid?: number }>(target: string, launch: () => Promise<T>, waitMs = LAUNCH_WINDOW_WAIT_MS): Promise<T & AppLaunchWindow> {
  const snap = /^https?:/iu.test(target.trim()) ? null : await listWindowsRaw();
  const r = await launch();
  if (!snap) return r;
  const before: WindowsBefore = new Map(snap.map((w) => [w.hwnd, w.foreground === true]));
  const deadline = Date.now() + waitMs;
  let answered = false;
  for (;;) {
    const after = await listWindowsRaw();
    if (after) {
      answered = true;
      const w = pickLaunchWindow(after, before, r.pid, target);
      if (w) return { ...r, window: { hwnd: w.hwnd, title: w.title } };
    }
    if (Date.now() + POLL_MS >= deadline) return answered ? { ...r, windowSeen: false } : r;
    await sleep(POLL_MS);
  }
}

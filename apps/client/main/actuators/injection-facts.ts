/**
 * W2 (пакет 0): ФАКТЫ для рубежа инжекции — тонкие ленивые обёртки БЕЗ политики. Политику (какой факт нужен и что из
 * него следует) держат судьи (self/secret/commit, П1/П2); здесь — только «спросить сайдкар/Electron и не зависнуть».
 *
 * Один набор фактов — на ОДНУ инжекцию: каждый факт запрашивается не больше раза (мемо), общий дедлайн ≈ 4 с — рубеж
 * не имеет права превратить печать буквы в секунды UIA. Истёк дедлайн или сайдкар не ответил → null («не знаю»):
 * fail-closed или fail-open на неизвестности решает судья, а не этот модуль.
 */
import * as electron from "electron";
import { type FocusedLine, parseFocusedLine } from "@jarvis/shared";
import { physicalRectToDip, type Point, type Rect } from "./coords.js";
import { type GroundResult, groundAtPoint } from "./ground.js";
import { sidecar } from "./sidecar-client.js";

/** Окно верхнего уровня как его отдаёт сайдкар — ЦЕЛИКОМ (свои окна и окна оверлея тоже), в z-порядке сверху вниз. */
export interface RawWindowFact {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  foreground: boolean;
  minimized: boolean;
  /** ФИЗИЧЕСКИЕ пиксели Win32. */
  rect: Rect;
}

export interface InjectionFacts {
  rawWindows(): Promise<RawWindowFact[] | null>;
  /** Верхнее по z-order видимое окно, чей rect (в DIP) содержит точку. */
  windowAt(dip: Point): Promise<RawWindowFact | null>;
  /** Элемент под точкой (`ground.at`, логические DIP). */
  elementAt(dip: Point): Promise<GroundResult | null>;
  /** Элемент в фокусе (`read.screen`, первая строка). */
  focused(): Promise<FocusedLine | null>;
  /** В фокусе ли окно самого Джарвиса (без сайдкара). */
  ownFocused(): boolean;
  clipboardText(): string;
}

export const FACTS_DEADLINE_MS = 4_000;
const WINDOW_LIST_MS = 1_500;
const UIA_FACT_MS = 2_000;

export interface FactsDeps {
  now?: () => number;
  electronApi?: { BrowserWindow?: { getFocusedWindow(): unknown }; clipboard?: { readText(): string } };
}

type RawSidecarWindow = Omit<RawWindowFact, "rect"> & { x: number; y: number; w: number; h: number };

export function createInjectionFacts(deps: FactsDeps = {}): InjectionFacts {
  const now = deps.now ?? Date.now;
  const until = now() + FACTS_DEADLINE_MS;
  const budget = (ms: number): number => Math.min(ms, until - now());
  const memo = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!memo.has(key)) memo.set(key, fn().catch(() => null));
    return memo.get(key) as Promise<T>;
  };
  const el = (): NonNullable<FactsDeps["electronApi"]> => deps.electronApi ?? (electron as unknown as NonNullable<FactsDeps["electronApi"]>);

  const rawWindows = (): Promise<RawWindowFact[] | null> =>
    once("windows", async () => {
      const ms = budget(WINDOW_LIST_MS);
      if (ms <= 0) return null;
      const data = (await sidecar().request("window.list", {}, ms)) as { windows?: RawSidecarWindow[] };
      if (!Array.isArray(data?.windows)) return null;
      return data.windows.map(({ x, y, w, h, ...rest }) => ({ ...rest, rect: { x, y, w, h } }));
    });

  return {
    rawWindows,
    windowAt: (p) =>
      once(`at:${p.x},${p.y}`, async () => {
        const wins = await rawWindows();
        if (!wins) return null;
        return (
          wins.find((w) => {
            if (w.minimized) return false;
            const r = physicalRectToDip(w.rect);
            return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
          }) ?? null
        );
      }),
    elementAt: (p) =>
      once(`el:${p.x},${p.y}`, async () => {
        const ms = budget(UIA_FACT_MS);
        return ms > 0 ? groundAtPoint(p.x, p.y, ms) : null;
      }),
    focused: () =>
      once("focused", async () => {
        const ms = budget(UIA_FACT_MS);
        if (ms <= 0) return null;
        const data = (await sidecar().request("read.screen", { maxChars: 300 }, ms)) as { text?: string };
        return parseFocusedLine(String(data?.text ?? ""));
      }),
    ownFocused: () => {
      try {
        return Boolean(el().BrowserWindow?.getFocusedWindow());
      } catch {
        return false;
      }
    },
    clipboardText: () => {
      try {
        return el().clipboard?.readText() ?? "";
      } catch {
        return "";
      }
    },
  };
}

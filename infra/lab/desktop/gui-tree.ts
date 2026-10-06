/**
 * UIA-дерево окна: узлы модели приложения + кнопки заголовка (свернуть/развернуть/закрыть), числовые handle, попадание
 * точки в узел, поиск по роли/имени, выжимка для наблюдения. Единственный источник «что видит сайдкар» в лаборатории.
 */
import type { DesktopWindow } from "../lib/contracts.js";
import type { Ctx, NodeSpec, PressOpts, UiaNode } from "./gui-model.js";
import { ActionError, zOrder } from "./gui-state.js";
import { closeWin, isMaximized, maximizeWin, minimizeWin, restoreWin } from "./gui-winops.js";

const HANDLE_STEP = 100_000;
const ids = new WeakMap<DesktopWindow, Map<string, number>>();

/** Числовой handle стабилен на всё время жизни окна: id узла ↔ номер закрепляется при первом появлении. */
function handleFor(w: DesktopWindow, id: string): number {
  let m = ids.get(w);
  if (!m) ids.set(w, (m = new Map()));
  let n = m.get(id);
  if (n === undefined) m.set(id, (n = m.size + 1));
  return w.hwnd * HANDLE_STEP + n;
}

function sysNodes(w: DesktopWindow): NodeSpec[] {
  const right = w.rect.x + w.rect.w;
  const btn = (id: string, name: string, k: number): NodeSpec => ({ id: `sys:${id}`, role: "button", name, label: "", x: right - 46 * (k + 1), y: w.rect.y, w: 46, h: 32, interactive: true });
  return [btn("close", "Закрыть", 0), btn("max", isMaximized(w) ? "Восстановить" : "Развернуть", 1), btn("min", "Свернуть", 2)];
}

export function treeOf(ctx: Ctx, w: DesktopWindow): UiaNode[] {
  return [...ctx.model(w).nodes(), ...sysNodes(w)].map((n) => ({ ...n, handle: handleFor(w, n.id) }));
}

/** Окна, видимые UIA: не свёрнутые, сверху вниз. */
export const visibleWindows = (ctx: Ctx): DesktopWindow[] => zOrder(ctx.core, ctx.st).filter((w) => !w.minimized);

export const windowOfHandle = (ctx: Ctx, handle: number): DesktopWindow | undefined => ctx.core.windows.get(Math.floor(handle / HANDLE_STEP));

/** Узел по handle; окно закрыто или узла больше нет — честная ошибка (handle устарел), а не «ok». */
export function resolveHandle(ctx: Ctx, handle: number | string): { w: DesktopWindow; node: UiaNode } {
  const n = Number(handle);
  const w = Number.isFinite(n) ? windowOfHandle(ctx, n) : undefined;
  const node = w ? treeOf(ctx, w).find((x) => x.handle === n) : undefined;
  if (!w || !node) throw new ActionError(`Элемент по handle ${String(handle).slice(0, 12)} не найден (окно закрыто или элемент исчез)`, "runtime");
  return { w, node };
}

const inside = (n: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean => x >= n.x && x < n.x + n.w && y >= n.y && y < n.y + n.h;

/** Окно под точкой (верхнее видимое) и глубочайший узел: предпочитаем интерактивный (actionable-предок), как ground.at. */
export function hitTest(ctx: Ctx, x: number, y: number): { w: DesktopWindow; node?: UiaNode } | undefined {
  const w = visibleWindows(ctx).find((win) => inside(win.rect, x, y));
  if (!w) return undefined;
  const hits = treeOf(ctx, w).filter((n) => inside(n, x, y));
  const area = (n: UiaNode): number => n.w * n.h;
  const best = (list: UiaNode[]): UiaNode | undefined => list.sort((a, b) => area(a) - area(b))[0];
  return { w, node: best(hits.filter((n) => n.interactive)) ?? best(hits) };
}

const CT: Record<string, string> = { menuitem: "MenuItem", listitem: "ListItem", tabitem: "TabItem", titlebar: "TitleBar", checkbox: "CheckBox" };
export const controlType = (role: string): string => `ControlType.${CT[role] ?? role.charAt(0).toUpperCase()}${CT[role] ? "" : role.slice(1)}`;
const normRole = (r: string): string => r.replace(/^controltype\./iu, "").replace(/\s+/gu, "").toLowerCase();
export const fold = (s: unknown): string => String(s ?? "").trim().toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ");

export interface GroundQuery {
  role: string;
  name?: string;
  nameMode?: "exact" | "substring";
  automationId?: string;
}

/** Поиск как у сайдкара: активное окно, затем остальные сверху вниз. Не найдено → ошибка с текстом C#. */
export function findNode(ctx: Ctx, q: GroundQuery, only?: DesktopWindow): { w: DesktopWindow; node: UiaNode } {
  const wins = only ? [only] : visibleWindows(ctx);
  for (const w of wins) {
    const hit = treeOf(ctx, w).find((n) => {
      if (normRole(n.role) !== normRole(q.role)) return false;
      if (q.automationId !== undefined && n.automationId !== q.automationId) return false;
      if (q.name === undefined) return true;
      return q.nameMode === "substring" ? fold(n.name).includes(fold(q.name)) : fold(n.name) === fold(q.name);
    });
    if (hit) return { w, node: hit };
  }
  throw new ActionError(`Элемент не найден: role=${q.role}, name=${q.name ?? "<any>"}`, "runtime");
}

/** Нажатие узла: кнопки заголовка обрабатывает система, остальное — модель приложения. */
export function pressNode(ctx: Ctx, w: DesktopWindow, node: UiaNode, o: PressOpts): void {
  if (node.id === "sys:close") return void closeWin(ctx, w, false, "titlebar");
  if (node.id === "sys:min") return minimizeWin(ctx, w);
  if (node.id === "sys:max") return isMaximized(w) ? restoreWin(ctx, w) : maximizeWin(ctx, w);
  ctx.model(w).press(node.id, o);
}

/** Строки выжимки окна («Button: Отправить [значение]») — основа наблюдения-дельты и context.read. */
export function digestLines(ctx: Ctx, w: DesktopWindow): string[] {
  return treeOf(ctx, w)
    .filter((n) => !n.id.startsWith("sys:") && (n.name || n.value))
    .map((n) => `${n.role.charAt(0).toUpperCase()}${n.role.slice(1)}: ${n.name}${n.value ? ` [${n.value.replace(/\s+/gu, " ").slice(0, 120)}]` : ""}`);
}

export interface Fingerprint {
  hwnd: number;
  title: string;
  lines: string[];
}

export function fingerprint(ctx: Ctx, w: DesktopWindow | undefined): Fingerprint | undefined {
  return w ? { hwnd: w.hwnd, title: w.title, lines: digestLines(ctx, w) } : undefined;
}

const excess = (a: string[], b: string[]): string[] => {
  const left = new Map<string, number>();
  for (const l of b) left.set(l, (left.get(l) ?? 0) + 1);
  return a.filter((l) => {
    const c = left.get(l) ?? 0;
    if (c > 0) left.set(l, c - 1);
    return c === 0;
  });
};

/** Наблюдение после действия (форма Observation настоящего клиента): дельта «+ появилось / − исчезло» или выжимка окна. */
export function observe(ctx: Ctx, before: Fingerprint | undefined): { via: "a11y"; window?: string; text: string; delta?: boolean; changed?: boolean } | undefined {
  const w = (before && ctx.core.windows.get(before.hwnd)) || zOrder(ctx.core, ctx.st).find((x) => !x.minimized);
  const after = fingerprint(ctx, w);
  if (!after) return undefined;
  if (!before) return { via: "a11y", window: after.title, text: after.lines.join("\n").slice(0, 900) };
  const appeared = excess(after.lines, before.lines);
  const gone = excess(before.lines, after.lines);
  const parts: string[] = [];
  if (before.title !== after.title) parts.push(`окно: «${before.title}» → «${after.title}»`);
  for (const l of appeared.slice(0, 10)) parts.push(`+ ${l}`);
  for (const l of gone.slice(0, 10)) parts.push(`− ${l}`);
  const changed = parts.length > 0;
  return {
    via: "a11y",
    window: after.title,
    text: changed ? parts.join("\n") : "структурных изменений в окне НЕ ВИДНО. Это не доказывает ни успех, ни провал: проверь целевой признак прицельно.",
    delta: true,
    changed,
  };
}

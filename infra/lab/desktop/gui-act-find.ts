/**
 * Поиск цели gui.act — лестница без раундов модели: handle → точка → снапшот UIA → OCR окна. Неоднозначность — честная
 * ошибка со списком видимого (никогда «первый попавшийся»: клик не туда с ok — ложный успех).
 */
import type { ActTarget } from "@jarvis/protocol";
import type { DesktopWindow } from "../lib/contracts.js";
import type { Ctx, UiaNode } from "./gui-model.js";
import { sceneLines } from "./gui-scene.js";
import { ActionError, type CoordSpace, toScreenPoint } from "./gui-state.js";
import { fold, hitTest, resolveHandle, treeOf } from "./gui-tree.js";

export const MAX_ACTIONABLE_W = 600;
export const MAX_ACTIONABLE_H = 300;
const CANDIDATES = 12;
const SNAPSHOT_MAX = 200;

export interface Found {
  via: "handle" | "point" | "snapshot" | "ocr";
  handle?: string;
  name: string;
  query?: string;
  role?: string;
  bbox?: { x: number; y: number; w: number; h: number };
  point?: { x: number; y: number };
  note?: string;
  node?: UiaNode;
  w?: DesktopWindow;
}

const cap = (r: string): string => r.charAt(0).toUpperCase() + r.slice(1);
const label = (n: UiaNode): string => `${n.role} «${n.name.slice(0, 40)}»${n.automationId ? ` [${n.automationId}]` : ""}`;

/** Балл совпадения узла снапшота с запросом (0 — не подходит); шкала и приоритеты — как у настоящего act-find. */
export function scoreItem(n: UiaNode, q: { text?: string; role?: string; automationId?: string }): number {
  if (q.automationId) return fold(n.automationId) === fold(q.automationId) ? 40 : 0;
  if (q.role && fold(n.role) !== fold(q.role)) return 0;
  if (!q.text) return q.role ? 1 : 0;
  const t = fold(q.text);
  const name = fold(n.name);
  if (!t) return 0;
  if (name === t) return 30;
  if (name.startsWith(t)) return 20;
  if (name.includes(t)) return 10;
  return fold(n.value).includes(t) ? 5 : 0;
}

/** Что под точкой: мелкий элемент → handle (бесшумный путь); контейнер/пусто → только точка (физический клик). */
export function findAtPoint(ctx: Ctx, p: { x: number; y: number }, via: "point" | "ocr", query: string): Found {
  const hit = hitTest(ctx, p.x, p.y);
  const n = hit?.node;
  if (!n) return { via, name: query, query, point: p, note: "под точкой нет UIA-элемента: действие пойдёт физическим кликом" };
  const bbox = { x: n.x, y: n.y, w: n.w, h: n.h };
  const under = `под точкой ${cap(n.role)} «${n.name.slice(0, 40)}»`;
  if (bbox.w > MAX_ACTIONABLE_W || bbox.h > MAX_ACTIONABLE_H) {
    return { via, name: n.name || query, query, point: p, bbox, node: n, ...(hit ? { w: hit.w } : {}), note: `${under} — контейнер ${bbox.w}×${bbox.h}, не кнопка: действие пойдёт физическим кликом в саму точку` };
  }
  return { via, handle: String(n.handle), name: n.name || query, query, role: cap(n.role), point: p, bbox, node: n, w: hit!.w, note: under };
}

function byOcr(ctx: Ctx, text: string, w: DesktopWindow | undefined): Found | null {
  if (!w) return null;
  const need = fold(text);
  const mine = sceneLines(ctx, w.rect).filter((l) => hitTest(ctx, l.x + l.w / 2, l.y + l.h / 2)?.w === w);
  const exact = mine.filter((l) => fold(l.text) === need);
  const hits = exact.length ? exact : mine.filter((l) => fold(l.text).includes(need));
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    throw new ActionError(`В окне «${w.title}» ${hits.length} строки с «${text}» — уточни role/x,y. Видно: ${hits.slice(0, CANDIDATES).map((h) => `«${h.text.slice(0, 40)}» @${h.x},${h.y}`).join("; ")}.`, "runtime");
  }
  const l = hits[0]!;
  const f = findAtPoint(ctx, { x: Math.round(l.x + l.w / 2), y: Math.round(l.y + l.h / 2) }, "ocr", l.text);
  return { ...f, note: `${f.note ? `${f.note}; ` : ""}найдено OCR в окне «${w.title}» (роль не проверена)` };
}

export function findTarget(ctx: Ctx, target: ActTarget, win: DesktopWindow | undefined, fg: DesktopWindow | undefined): Found {
  const q: { text?: string; role?: string; automationId?: string; handle?: string; x?: number; y?: number } & CoordSpace = typeof target === "string" ? { text: target } : target;
  if (q.handle) {
    const r = resolveHandle(ctx, q.handle);
    return { via: "handle", handle: String(q.handle), name: r.node.name, ...(q.text ? { query: q.text } : {}), role: r.node.role, node: r.node, w: r.w, bbox: { x: r.node.x, y: r.node.y, w: r.node.w, h: r.node.h } };
  }
  if (typeof q.x === "number" && typeof q.y === "number") return findAtPoint(ctx, toScreenPoint(ctx.st, q.x, q.y, q), "point", q.text ?? `точка ${q.x},${q.y}`);
  if (!q.text && !q.role && !q.automationId) throw new ActionError("Цель пустая: нужен text, role, automationId, handle или x/y.", "runtime");
  const w = win ?? fg;
  const items = w ? treeOf(ctx, w).filter((n) => n.interactive) : [];
  const truncated = items.length > SNAPSHOT_MAX;
  const scored = items.slice(0, SNAPSHOT_MAX).map((n) => ({ n, s: scoreItem(n, q) })).filter((x) => x.s > 0);
  const seen = items.slice(0, CANDIDATES).map(label);
  if (scored.length > 0) {
    const best = Math.max(...scored.map((x) => x.s));
    const top = scored.filter((x) => x.s === best);
    if (top.length > 1) throw new ActionError(`Цель неоднозначна: ${top.length} равных совпадения — уточни role/automationId или handle из ui_snapshot. Видно: ${top.slice(0, CANDIDATES).map((x) => label(x.n)).join("; ")}.`, "runtime");
    const n = top[0]!.n;
    return { via: "snapshot", handle: String(n.handle), name: n.name, query: q.text, role: n.role, bbox: { x: n.x, y: n.y, w: n.w, h: n.h }, node: n, w: w! };
  }
  if (q.text) {
    const o = byOcr(ctx, q.text, w);
    if (o) return o;
  }
  const what = q.text ? `«${q.text}»` : q.automationId ? `automationId «${q.automationId}»` : `роль «${q.role}»`;
  const capNote = truncated ? ` Снапшот усечён (${SNAPSHOT_MAX} элементов) — цель могла быть за капом.` : "";
  throw new ActionError(`Цель ${what} не найдена ни в UIA-снапшоте активного окна, ни OCR.${capNote} Проверь, то ли окно активно (app), и подбери имя из списка. Видно: ${seen.join("; ")}.`, "runtime");
}

/**
 * W2 П1: ЦЕЛИ суда §14 для одной инжекции — процесс (process-of) и то, ЧТО нажимается (элемент зеркала/под точкой,
 * элемент в фокусе). Политики здесь нет: только «куда уходит» и ленивые факты (ground.at — лишь если процесс
 * рискованный или неизвестен; клик в обычной программе стоит один window.list и ноль ground.at).
 */
import { type ElementFacts, type InjectOp, keyClass, textIntents } from "@jarvis/shared";
import type { InjectionCase } from "./injection-guard.js";
import type { MirrorEntry } from "./handle-mirror.js";
import { type Point, physicalRectToDip } from "./coords.js";
import { type ProcFact, foregroundOf, handleOf, mirrorLookup, pointOf } from "./process-of.js";

/** Что вообще может оказаться коммитом (без фактов). null — судить нечего. */
export type CommitKind = "key" | "text" | "element";

const PRESS_PATTERNS: ReadonlySet<string> = new Set(["invoke", "select", "toggle"]);
/** Короткий drag (сдвиг < 8 DIP) — это клик по элементу в точке from. */
const DRAG_CLICK_DIP = 8;

export function commitKind(c: InjectionCase): CommitKind | null {
  const p = c.params;
  if (c.op === "key") {
    if (p.mode === "up") return null;
    const k = keyClass(String(p.combo ?? ""));
    return k === "commit" || k === "focusPress" ? "key" : null;
  }
  if (c.op === "type") return textIntents(p.text).newlines > 0 ? "text" : null;
  if (c.op === "click") return p.button === "right" ? null : "element";
  if (c.op === "invoke") return PRESS_PATTERNS.has(String(p.pattern ?? "invoke")) ? "element" : null;
  return p.op === "down" || p.op === "drag" ? "element" : null;
}

/** Одна цель: процесс, операция для opCommitIntent и ленивый элемент (null — не узнали). */
export interface CommitTarget {
  proc: ProcFact | null;
  op: InjectOp;
  params: Record<string, unknown>;
  element?: () => Promise<ElementFacts | null>;
  /** Запись зеркала (handle) — для пересверки устаревшей. */
  entry?: MirrorEntry;
  /** handle, которого зеркало не знает (старый снапшот, рестарт сайдкара): ни элемента, ни процесса. */
  unknownHandle?: string;
}

const pt = (x: unknown, y: unknown): Point | null => (typeof x === "number" && typeof y === "number" ? { x, y } : null);

function atPoint(c: InjectionCase, p: Point): () => Promise<ElementFacts | null> {
  return async () => {
    const g = await c.facts.elementAt(p);
    return g ? { name: g.name, role: g.role } : null;
  };
}

/** Короткий drag: конец внутри bbox элемента начала (DIP) или сдвиг < 8 DIP. */
async function shortDrag(c: InjectionCase, from: Point, to: Point): Promise<boolean> {
  if (Math.hypot(to.x - from.x, to.y - from.y) < DRAG_CLICK_DIP) return true;
  const g = await c.facts.elementAt(from);
  if (!g) return false;
  const b = physicalRectToDip(g.bbox);
  return to.x >= b.x && to.x < b.x + b.w && to.y >= b.y && to.y < b.y + b.h;
}

/** Цели инжекции `c` вида `kind`. */
export async function commitTargets(c: InjectionCase, kind: CommitKind): Promise<CommitTarget[]> {
  const p = c.params;
  if (kind !== "element") return [{ proc: await foregroundOf(c.facts), op: c.op, params: p }];
  if ((c.op === "click" || c.op === "invoke") && p.handle !== undefined && p.handle !== null) {
    const e = mirrorLookup(p.handle);
    if (!e) return [{ proc: null, op: c.op, params: p, element: async () => null, unknownHandle: String(p.handle) }];
    return [{ proc: await handleOf(c.facts, e), op: c.op, params: p, entry: e, element: async () => ({ name: e.name, role: e.role }) }];
  }
  const from = pt(p.x, p.y) ?? (c.op === "mouse" ? c.facts.cursor() : null);
  if (!from) return [{ proc: null, op: c.op, params: p, element: async () => null }];
  const here: CommitTarget = { proc: await pointOf(c.facts, from), op: c.op, params: p, element: atPoint(c, from) };
  if (c.op !== "mouse" || p.op !== "drag") return [here];
  const to = pt(p.toX, p.toY);
  const out: CommitTarget[] = [];
  if (to) out.push({ proc: await pointOf(c.facts, to), op: "mouse", params: { op: "drag" }, element: atPoint(c, to) });
  if (!to || (await shortDrag(c, from, to))) out.push({ ...here, op: "click", params: { button: p.button ?? "left", count: 1 } });
  return out;
}

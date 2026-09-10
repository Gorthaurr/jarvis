/**
 * W4 «Руки» (2026-09-10): ПОИСК цели примитива gui.act — лестница без раундов модели между ступенями.
 *
 * Ступени (в порядке дешевизны и надёжности):
 *  1. handle — цель уже адресована (из ui.snapshot): ничего не ищем.
 *  2. точка (x/y) — элемент под точкой через UIA (`ground.at`): даёт handle для бесшумного действия; под
 *     точкой ничего нет (canvas/игра) — остаётся сама точка для физического клика.
 *  3. снапшот UIA активного окна — совпадение по тексту (точное > префикс > подстрока > value), роли и
 *     automationId. Несколько РАВНЫХ кандидатов → ЧЕСТНАЯ ошибка со списком: «выбрать первый» — это клик
 *     не туда с ok, ровно тот ложный успех, который проект не прощает.
 *  4. OCR всего экрана — для UIA-слепых окон: строка с текстом → центр в АБСОЛЮТНЫХ экранных DIP (mapping
 *     кадра, как у jarvis SDK) → снова `ground.at` (бесшумный путь) или точка для физического клика.
 *
 * Координаты bbox снапшота — ФИЗИЧЕСКИЕ пиксели, по ним НЕ кликаем (тот же запрет, что в SDK): только
 * handle → invoke. Не найдено → ошибка перечисляет, что реально видно (модель перецеливается без скриншота).
 * Бюджет: каждая ступень проверяет, хватает ли времени до дедлайна, — иначе честная остановка на ступени.
 */
import type { ActTarget } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { groundAtPoint, type UiSnapshotItem, uiSnapshot } from "./ground.js";
import { getLastCaptureMapping } from "./screen.js";
import { screenOcr } from "./sensors-cheap.js";

const log = createLogger("actuator:act-find");

/** Что нашли и как — едет в ответ модели (found) и в act-do (handle/point). */
export interface FoundTarget {
  via: "handle" | "point" | "snapshot" | "ocr";
  handle?: string;
  name: string;
  role?: string;
  /** Экранные DIP точки действия (есть у point/ocr) — база OCR-снимка «до/после» и физического клика. */
  point?: { x: number; y: number };
  /** Честная пометка (снапшот усечён, роль не проверена OCR и т.п.). */
  note?: string;
}

/** Провал поиска с тем, что реально видно, — модель перецеливается по списку, а не по скриншоту. */
export class ActFindError extends Error {
  constructor(
    message: string,
    readonly candidates: string[] = [],
  ) {
    super(candidates.length ? `${message} Видно: ${candidates.join("; ")}.` : message);
    this.name = "ActFindError";
  }
}

/** Снапшот просим с потолком сайдкара; после него цель может быть «за капом» — это говорится честно. */
export const SNAPSHOT_MAX_ITEMS = 200;
/** Сколько времени нужно оставить на ступень (снапшот UIA до 12 с, OCR до 20 с) — иначе на неё не идём. */
const NEED_SNAPSHOT_MS = 3_000;
const NEED_OCR_MS = 8_000;
const CANDIDATE_CAP = 12;

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ");

interface Query {
  text?: string;
  role?: string;
  automationId?: string;
}

/** Балл совпадения элемента снапшота с запросом. 0 — не подходит. ЧИСТАЯ функция (экспорт для теста). */
export function scoreItem(it: UiSnapshotItem, q: Query): number {
  if (q.automationId) return norm(it.automationId) === norm(q.automationId) ? 40 : 0;
  if (q.role && norm(it.role) !== norm(q.role)) return 0;
  if (!q.text) return q.role ? 1 : 0;
  const t = norm(q.text);
  const name = norm(it.name);
  if (!t) return 0;
  if (name === t) return 30;
  if (name.startsWith(t)) return 20;
  if (name.includes(t)) return 10;
  if (norm(it.value).includes(t)) return 5;
  return 0;
}

const label = (it: UiSnapshotItem): string => `${it.role} «${String(it.name ?? "").slice(0, 40)}»${it.automationId ? ` [${it.automationId}]` : ""}`;

function toScreen(x: number, y: number, space?: "screen"): { x: number; y: number } {
  if (space === "screen") return { x, y };
  const m = getLastCaptureMapping();
  return m ? { x: m.boundsX + x / m.scale, y: m.boundsY + y / m.scale } : { x, y };
}

/** Ступень «точка»: элемент под точкой → handle; ничего нет → сама точка (физический путь). */
async function findAtPoint(p: { x: number; y: number }, via: "point" | "ocr", name: string): Promise<FoundTarget> {
  try {
    const g = await groundAtPoint(p.x, p.y);
    return { via, handle: g.handle, name, point: p };
  } catch (e) {
    log.debug("act-find: под точкой нет UIA-элемента — физический путь", e instanceof Error ? e.message : String(e));
    return { via, name, point: p, note: "под точкой нет UIA-элемента: действие пойдёт физическим кликом" };
  }
}

/** Ступень «снапшот»: лучший по баллу; равных ≥2 → ошибка с кандидатами; ничего → null + что видно. */
async function findInSnapshot(q: Query): Promise<{ found: FoundTarget | null; seen: string[]; truncated: boolean }> {
  const snap = await uiSnapshot(undefined, SNAPSHOT_MAX_ITEMS);
  const scored = snap.items.map((it) => ({ it, s: scoreItem(it, q) })).filter((x) => x.s > 0);
  const seen = snap.items.slice(0, CANDIDATE_CAP).map(label);
  if (scored.length === 0) return { found: null, seen, truncated: snap.truncated };
  const best = Math.max(...scored.map((x) => x.s));
  const top = scored.filter((x) => x.s === best);
  if (top.length > 1) {
    throw new ActFindError(
      `Цель неоднозначна: ${top.length} равных совпадения — уточни role/automationId или handle из ui_snapshot.`,
      top.slice(0, CANDIDATE_CAP).map((x) => label(x.it)),
    );
  }
  const it = top[0]!.it;
  return { found: { via: "snapshot", handle: String(it.handle), name: it.name, role: it.role }, seen, truncated: snap.truncated };
}

/** Ступень OCR: строка с текстом → центр в экранных DIP (mapping полного кадра) → ground.at или точка. */
async function findByOcr(text: string): Promise<FoundTarget | null> {
  const ocr = await screenOcr();
  const t = norm(text);
  const hits = ocr.lines.filter((l) => norm(l.text).includes(t));
  if (hits.length === 0) return null;
  if (!ocr.mapping) throw new ActFindError("OCR нашёл текст, но кадр без маппинга координат — кликнуть по нему честно нельзя.");
  const exact = hits.filter((l) => norm(l.text) === t);
  const pick = exact.length ? exact : hits;
  if (pick.length > 1) {
    throw new ActFindError(
      `На экране ${pick.length} строки с «${text}» — уточни role/x,y.`,
      pick.slice(0, CANDIDATE_CAP).map((l) => `«${l.text.slice(0, 40)}» @${Math.round(l.x + l.w / 2)},${Math.round(l.y + l.h / 2)}`),
    );
  }
  const l = pick[0]!;
  const m = ocr.mapping;
  const p = { x: m.boundsX + (l.x + l.w / 2) / m.scale, y: m.boundsY + (l.y + l.h / 2) / m.scale };
  const f = await findAtPoint(p, "ocr", l.text);
  return { ...f, note: `${f.note ? `${f.note}; ` : ""}найдено OCR (роль не проверена)` };
}

/** Найти цель по лестнице. deadline — абсолютное время (Date.now()), после которого ступени не начинаем. */
export async function findTarget(target: ActTarget, deadline: number): Promise<FoundTarget> {
  const q: Query & { handle?: string; x?: number; y?: number; space?: "screen" } = typeof target === "string" ? { text: target } : target;
  if (q.handle) return { via: "handle", handle: String(q.handle), name: `handle ${q.handle}` };
  if (typeof q.x === "number" && typeof q.y === "number") return findAtPoint(toScreen(q.x, q.y, q.space), "point", q.text ?? `точка ${q.x},${q.y}`);
  if (!q.text && !q.role && !q.automationId) throw new ActFindError("Цель пустая: нужен text, role, automationId, handle или x/y.");
  const remaining = (): number => deadline - Date.now();
  if (remaining() < NEED_SNAPSHOT_MS) throw new ActFindError("Бюджет act исчерпан до поиска цели — повтори с меньшим verify.timeoutMs или без app.");
  const snap = await findInSnapshot(q);
  if (snap.found) return snap.found;
  const capNote = snap.truncated ? ` Снапшот усечён (${SNAPSHOT_MAX_ITEMS} элементов) — цель могла быть за капом.` : "";
  if (q.text) {
    if (remaining() < NEED_OCR_MS) throw new ActFindError(`«${q.text}» в UIA-снапшоте нет, на OCR времени не осталось.${capNote}`, snap.seen);
    const byOcr = await findByOcr(q.text);
    if (byOcr) return byOcr;
  }
  const what = q.text ? `«${q.text}»` : q.automationId ? `automationId «${q.automationId}»` : `роль «${q.role}»`;
  throw new ActFindError(`Цель ${what} не найдена ни в UIA-снапшоте активного окна, ни OCR.${capNote} Проверь, то ли окно активно (app), и подбери имя из списка.`, snap.seen);
}

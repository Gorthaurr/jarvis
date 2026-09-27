/**
 * W2 (пакет 0): ЗЕРКАЛО HANDLE — что клиент знает об UIA-элементе по его handle (из ui.snapshot, ground, ground.at).
 *
 * Рубежу инжекции (П1) нужно судить `invoke{handle:41}` по НАСТОЯЩЕМУ элементу: имя («Отправить»), роль, процесс (pid),
 * bbox, значение (`•••` — поле-пароль для §0, П2). Сайдкар по handle этого не отдаёт (C# `describe` — §6 плана), поэтому
 * клиент запоминает то, что уже видел. Запись живёт в своём поколении сайдкара (после рестарта handle — чужие).
 * УСТАРЕВАНИЕ (П1, №4): через 20 с или после любой инжекции в тот же pid (ввод без известного pid — во все). Устаревшую
 * запись в рискованном процессе рубеж пересверяет пересъёмкой (commit-recheck.ts): «Записать голосовое» после печати
 * становится «Отправить» на том же месте.
 */

export interface MirrorEntry {
  name: string;
  role: string;
  value?: string | null;
  automationId?: string | null;
  /** Процесс окна элемента (у снапшота — pid корня; у ground/ground.at сайдкар pid пока не отдаёт). */
  pid?: number;
  /** ФИЗИЧЕСКИЕ пиксели (UIA BoundingRectangle). */
  bbox: { x: number; y: number; w: number; h: number };
  /** Поколение сайдкара, в котором handle выдан. */
  gen: number;
  staleAt: number;
  /** Когда записано (сравнивается с отметками инжекций). */
  notedAt: number;
}

export const MIRROR_TTL_MS = 20_000;
const MIRROR_MAX = 2_000;

const entries = new Map<string, MirrorEntry>();
/** Последняя инжекция по pid и «куда-то» (клавиатура без выяснения процесса). */
const injectedAt = new Map<number, number>();
let anyInjectedAt = 0;

function put(handle: unknown, e: Omit<MirrorEntry, "staleAt" | "notedAt">, now: number): void {
  const key = String(handle ?? "");
  if (!key) return;
  entries.delete(key); // свежая запись — в хвост (порядок вставки = LRU)
  entries.set(key, { ...e, staleAt: now + MIRROR_TTL_MS, notedAt: now });
  while (entries.size > MIRROR_MAX) entries.delete(entries.keys().next().value as string);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Элементы снапшота (реальная форма: handle числом, роль короткая «button», bbox плоский x/y/w/h). */
export function noteSnapshot(
  snap: { pid?: number; items: ReadonlyArray<{ handle: unknown; role?: string; name?: string; automationId?: string | null; value?: string | null; x?: number; y?: number; w?: number; h?: number }> },
  gen: number,
  now = Date.now(),
): void {
  for (const it of snap.items) {
    put(it.handle, { name: String(it.name ?? ""), role: String(it.role ?? ""), value: it.value, automationId: it.automationId, pid: snap.pid, bbox: { x: num(it.x), y: num(it.y), w: num(it.w), h: num(it.h) }, gen }, now);
  }
}

/** Элемент ground/ground.at (роль «ControlType.Button», bbox уже разобран ground.ts). pid — если известен по scope. */
export function noteGround(g: { handle: string; bbox: { x: number; y: number; w: number; h: number }; name?: string; role?: string }, gen: number, now = Date.now(), pid?: number): void {
  put(g.handle, { name: g.name ?? "", role: g.role ?? "", bbox: g.bbox, gen, ...(pid !== undefined ? { pid } : {}) }, now);
}

/** Процесс стал известен позже (ground по scope, окно под bbox) — дописать pid, не освежая запись. */
export function attachPid(handle: unknown, pid: number): void {
  const e = entries.get(String(handle ?? ""));
  if (e && e.pid === undefined) e.pid = pid;
}

/** Инжекция ушла в процесс `pid` (null — процесс не выяснялся): его записи устаревают. */
export function noteInjected(pid: number | null | undefined, now = Date.now()): void {
  if (pid === null || pid === undefined) anyInjectedAt = now;
  else injectedAt.set(pid, now);
}

/** Запись устарела: срок вышел или после неё была инжекция в её процесс (или неизвестно куда). */
export function isStale(e: MirrorEntry, now = Date.now()): boolean {
  if (now >= e.staleAt || e.notedAt <= anyInjectedAt) return true;
  return e.pid !== undefined && e.notedAt <= (injectedAt.get(e.pid) ?? 0);
}

/** Запись по handle в ТЕКУЩЕМ поколении (чужое поколение — null: handle уже указывает на другой элемент). */
export function mirrorOf(handle: unknown, gen: number): MirrorEntry | null {
  const e = entries.get(String(handle ?? ""));
  return e && e.gen === gen ? e : null;
}

/** Сбросить зеркало (тест / рестарт сайдкара). */
export function resetMirror(): void {
  entries.clear();
  injectedAt.clear();
  anyInjectedAt = 0;
}

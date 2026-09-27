/**
 * W2 П1 (безопасность №3, осуществимость 3.8): ПРОЦЕСС ЦЕЛИ инжекции — по найденному элементу и реальному окну,
 * БЕЗ подстановки «иначе — передний план» для мыши и UIA (это был обход: Chrome спереди, а «Отправить» жмётся в
 * Telegram под ним):
 *  - handle → pid из зеркала (снапшот/ground по scope); без pid — окно под центром его bbox;
 *  - точка → верхнее по z-order окно под ней (windowAt);
 *  - клавиатура → передний план; окно без заголовка (его нет в window.list) → `ui.snapshot{maxItems:1}.pid`;
 *  - мутирующий ground по role/name → сперва `scope:"active"`, затем `scope=<pid>` по ≤ 6 верхним окнам (без своего).
 * Не определено → null: рубеж отклоняет КАНДИДАТА в коммит честно («не смог определить программу — укажи app»).
 */
import { normRole } from "@jarvis/shared";
import { type InjectionFacts, type RawWindowFact, createInjectionFacts } from "./injection-facts.js";
import { type MirrorEntry, attachPid, mirrorOf } from "./handle-mirror.js";
import { type Point, physicalRectToDip } from "./coords.js";
import { type GroundResult, ground } from "./ground.js";
import { sidecar } from "./sidecar-client.js";

/** Процесс и окно цели. */
export interface ProcFact {
  pid: number;
  /** Имя образа («Telegram»); пусто не бывает — неизвестное имя = нет факта. */
  process: string;
  title: string;
  hwnd?: number;
}

const toProc = (w: RawWindowFact): ProcFact => ({ pid: w.pid, process: w.process, title: w.title, hwnd: w.hwnd });

/** Поколение сайдкара (моки без него — 0). */
export const sidecarGen = (): number => (sidecar() as { generation?: number }).generation ?? 0;

/** Запись зеркала по handle в текущем поколении сайдкара. */
export const mirrorLookup = (handle: unknown): MirrorEntry | null => mirrorOf(handle, sidecarGen());

/** Центр физического bbox в DIP (пустой bbox — null). */
export function bboxCenterDip(b: { x: number; y: number; w: number; h: number }): Point | null {
  if (!(b.w > 0 && b.h > 0)) return null;
  const d = physicalRectToDip(b);
  return { x: d.x + d.w / 2, y: d.y + d.h / 2 };
}

/** Передний план (клавиатура). Окно без заголовка → pid по UIA → окно этого процесса из списка. */
export async function foregroundOf(f: InjectionFacts): Promise<ProcFact | null> {
  const wins = await f.rawWindows();
  const fg = wins?.find((w) => w.foreground);
  if (fg) return toProc(fg);
  const pid = await f.snapshotPid();
  const same = pid === null ? undefined : wins?.find((w) => w.pid === pid);
  return same ? { pid: same.pid, process: same.process, title: same.title } : null;
}

/** Точка → верхнее по z-order окно под ней. */
export async function pointOf(f: InjectionFacts, p: Point): Promise<ProcFact | null> {
  const w = await f.windowAt(p);
  return w ? toProc(w) : null;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 8;

/**
 * handle → процесс его окна. pid из зеркала (снапшот, ground по scope) → окно этого pid (под центром bbox, иначе
 * верхнее). pid неизвестен (ground без scope, ground.at) → окно под центром bbox, НО только если элемент там сверху
 * (ground.at в центре вернул его же): иначе «Отправить» Telegram под Блокнотом судилась бы как Блокнот.
 */
export async function handleOf(f: InjectionFacts, e: MirrorEntry): Promise<ProcFact | null> {
  const c = bboxCenterDip(e.bbox);
  const at = c ? await f.windowAt(c) : null;
  if (e.pid === undefined) {
    const top = c && at ? await f.elementAt(c) : null;
    const same = !!top && (top.name ?? "") === e.name && normRole(top.role) === normRole(e.role) && (["x", "y", "w", "h"] as const).every((k) => near(top.bbox[k], e.bbox[k]));
    return same && at ? toProc(at) : null;
  }
  if (at && at.pid === e.pid) return toProc(at);
  const w = (await f.rawWindows())?.find((x) => x.pid === e.pid);
  return w ? toProc(w) : null;
}

const PID_SCAN_MAX = 6;
const PID_GROUND_MS = 3_000;
/** Весь поиск укладывается в прежний потолок одного ground (12 с): активное окно — до 6 с, каждый pid — до 3 с. */
const GROUND_BUDGET_MS = 12_000;
const ACTIVE_GROUND_MS = 6_000;

/**
 * Мутирующий ground по role/name (клик/invoke по роли): активное окно, затем ≤ 6 верхних окон по z-order (свои и
 * свёрнутые — мимо). pid найденного элемента известен по scope и дописывается в зеркало — рубеж судит его процесс.
 * Прежний ground без scope искал по всему столу: «Отправить» находилась в Telegram ПОД Chrome, а судился Chrome.
 */
export async function groundForAction(q: { role: string; name?: string }): Promise<GroundResult & { pid?: number }> {
  const until = Date.now() + GROUND_BUDGET_MS;
  const f = createInjectionFacts();
  const wins = (await f.rawWindows()) ?? [];
  const fg = wins.find((w) => w.foreground);
  let first: unknown;
  try {
    const g = await ground({ ...q, scope: "active" }, ACTIVE_GROUND_MS);
    const pid = fg?.pid ?? (await f.snapshotPid()) ?? undefined;
    if (pid !== undefined) attachPid(g.handle, pid);
    return { ...g, ...(pid !== undefined ? { pid } : {}) };
  } catch (e) {
    first = e;
  }
  const tried = new Set<number>([process.pid, ...(fg ? [fg.pid] : [])]);
  let scanned = 0;
  for (const w of wins) {
    const left = until - Date.now();
    if (scanned >= PID_SCAN_MAX || left < 500) break;
    if (w.minimized || tried.has(w.pid)) continue;
    tried.add(w.pid);
    scanned += 1;
    try {
      const g = await ground({ ...q, scope: String(w.pid) }, Math.min(PID_GROUND_MS, left));
      attachPid(g.handle, w.pid);
      return { ...g, pid: w.pid };
    } catch {
      /* в этом окне нет — следующее по z-order */
    }
  }
  throw first;
}

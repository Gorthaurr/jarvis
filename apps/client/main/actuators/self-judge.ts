/**
 * W2 П1 (безопасность №1, G-11): судья «self» рубежа инжекции — НЕОДОБРЯЕМЫЙ отказ любой мутации в СВОЙ процесс.
 *
 * Модалка «Подтвердить» §14 — обычный DOM-клик в окне Джарвиса: python с моста, реплей или act, нажавший её сам,
 * одобрил бы свою же отправку. Поэтому своё окно не судится грантом — отказ всегда:
 *  - handle, у которого pid в зеркале = process.pid (без pid — окно под центром bbox);
 *  - точка (клик, `mouse down` — без координат в позиции курсора, drag, колесо): верхнее по z-order окно под ней наше;
 *    window.list недоступен — точка внутри видимого своего BrowserWindow;
 *  - клавиатура при фокусе у окна Джарвиса.
 * G-11: act сфокусировал окно `app` (область несёт `expectedForeground`) — клавиатура уходит только в него; передний
 * план сменился → «фокус ушёл на «Y», ничего не напечатано».
 */
import type { InjectionCase, Judge, JudgeDenial } from "./injection-guard.js";
import type { Point } from "./coords.js";
import { bboxCenterDip, mirrorLookup } from "./process-of.js";

const OWN = "это окно самого Джарвиса — свои кнопки, поля и модалку подтверждения я не нажимаю (не одобряется)";

const deny = (message: string): JudgeDenial => ({ message });

/** Точки мыши, которые что-то нажимают/двигают в окне (up и move — нет). */
function mousePoints(c: InjectionCase): Point[] {
  const p = c.params;
  const at = (x: unknown, y: unknown): Point | null => (typeof x === "number" && typeof y === "number" ? { x, y } : null);
  const from = at(p.x, p.y);
  if (p.op === "down") return [from ?? c.facts.cursor()].filter((v): v is Point => !!v);
  if (p.op === "wheel") return [from ?? c.facts.cursor()].filter((v): v is Point => !!v);
  if (p.op === "drag") return [from ?? c.facts.cursor(), at(p.toX, p.toY)].filter((v): v is Point => !!v);
  return [];
}

async function pointIsOwn(c: InjectionCase, pt: Point): Promise<boolean> {
  const w = await c.facts.windowAt(pt);
  if (w) return w.pid === process.pid;
  return (await c.facts.rawWindows()) === null && c.facts.ownWindowAt(pt);
}

async function handleIsOwn(c: InjectionCase, handle: unknown): Promise<boolean> {
  const e = mirrorLookup(handle);
  if (!e) return false; // неизвестный handle судит commit (кандидат при неизвестном процессе)
  if (e.pid !== undefined) return e.pid === process.pid;
  const center = bboxCenterDip(e.bbox);
  return center ? pointIsOwn(c, center) : false;
}

async function keyboard(c: InjectionCase): Promise<JudgeDenial | null> {
  if (c.op === "key" && c.params.mode === "up") return null; // отпустить — ничего не нажимает
  if (c.facts.ownFocused()) return deny(`${OWN}: фокус у окна Джарвиса — укажи app (в какой программе печатать/жать); ничего не нажато`);
  const exp = c.scope?.expectedForeground;
  if (!exp) return null;
  const wins = await c.facts.rawWindows();
  if (!wins) return null; // список окон недоступен — коммит судит commit по своим фактам
  const fg = wins.find((w) => w.foreground);
  if (fg && fg.hwnd === exp.hwnd) return null;
  const now = fg ? `«${fg.title.slice(0, 60)}»` : "окно без заголовка";
  return deny(`фокус ушёл с «${exp.title.slice(0, 60)}» на ${now} — ничего не ${c.op === "type" ? "напечатано" : "нажато"}; повтори act с app`);
}

export const selfJudge: Judge = async (c) => {
  if (c.op === "key" || c.op === "type") return keyboard(c);
  const p = c.params;
  if ((c.op === "click" || c.op === "invoke") && p.handle !== undefined && p.handle !== null) {
    return (await handleIsOwn(c, p.handle)) ? deny(`${OWN}; ничего не нажато`) : null;
  }
  const points = c.op === "click" ? [{ x: Number(p.x), y: Number(p.y) }] : c.op === "mouse" ? mousePoints(c) : [];
  for (const pt of points) {
    if (Number.isFinite(pt.x) && Number.isFinite(pt.y) && (await pointIsOwn(c, pt))) return deny(`${OWN}; ничего не нажато`);
  }
  return null;
};

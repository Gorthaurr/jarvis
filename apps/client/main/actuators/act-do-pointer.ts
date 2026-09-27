/**
 * W2 (П4, G-19/G-17): глаголы указателя gui.act — triple, middle, hover, scroll, drag. Все — ФИЗИЧЕСКИЙ ввод через
 * рубеж инжекции (input.click / input.mouse → injectRpc), UIA-паттерна у них нет:
 *  - triple — клик ×3 (выделить строку/абзац); middle — средняя кнопка (ссылка в новой вкладке, закрыть вкладку);
 *  - hover — курсор в центр цели (тултипы, ховер-меню);
 *  - scroll — колесо В ЦЕЛИ (dx/dy тики, +вверх/−вниз): обход G-17 — UIA ScrollPattern сайдкара крутит только вниз
 *    и шагом SmallIncrement, колесо в элементе крутит туда, куда просили;
 *  - drag — перетащить из цели в `to` (вторая цель ищется той же лестницей findTarget).
 * Точка цели: найденная точка (DIP) → bbox элемента (ФИЗИЧЕСКИЕ пиксели → physicalRectToDip → центр) → bbox из зеркала
 * handle. Нет ни того, ни другого → честная ошибка ДО действия. Координат для авто-макроса §8 не отдаём: реплей
 * повторил бы жест обычным кликом.
 */
import type { FoundTarget } from "./act-find.js";
import { findTarget } from "./act-find.js";
import type { ActCommand } from "./act-args.js";
import { type ActDone, type ActParams, physicalClick } from "./act-do.js";
import { physicalRectToDip } from "./coords.js";
import { mirrorOf } from "./handle-mirror.js";
import { mouse } from "./input.js";
import { sidecar } from "./sidecar-client.js";

export type PointerVerb = "triple" | "middle" | "hover" | "drag" | "scroll";

/** Бюджет поиска цели `to` у drag (снапшот UIA ≤ 12 с + OCR). */
const DRAG_FIND_MS = 25_000;

const gen = (): number => (sidecar() as { generation?: number }).generation ?? 0;

/** Экранная DIP-точка цели или ошибка ДО действия. */
export function pointOf(f: FoundTarget): { x: number; y: number } {
  if (f.point) return f.point;
  const bbox = f.bbox ?? (f.handle ? mirrorOf(f.handle, gen())?.bbox : undefined);
  if (bbox && bbox.w > 0 && bbox.h > 0) {
    const d = physicalRectToDip(bbox);
    return { x: d.x + d.w / 2, y: d.y + d.h / 2 };
  }
  throw new Error(`«${f.name}»: неизвестно, где элемент на экране (нет точки и bbox) — указателем туда не попасть. Ничего не сделано; возьми цель из look{what:'elements'} или x/y.`);
}

const at = (p: { x: number; y: number }): string => `${Math.round(p.x)},${Math.round(p.y)}`;

export async function doPointer(found: FoundTarget, verb: PointerVerb, cmd: ActCommand, p: ActParams): Promise<ActDone> {
  switch (verb) {
    case "triple":
    case "middle": {
      const r = await physicalClick(found, p, verb === "triple" ? { count: 3 } : { button: "middle" });
      return { did: r.did, physical: true };
    }
    case "hover": {
      const pt = pointOf(found);
      await mouse({ op: "move", x: pt.x, y: pt.y, space: "screen" });
      return { did: `навёл курсор на «${found.name}» (${at(pt)})`, physical: true };
    }
    case "scroll": {
      const pt = pointOf(found);
      await mouse({ op: "wheel", x: pt.x, y: pt.y, dx: cmd.dx, dy: cmd.dy, space: "screen" });
      return { did: `прокрутил колесом в «${found.name}» (dy=${cmd.dy ?? 0}, dx=${cmd.dx ?? 0})`, physical: true };
    }
    case "drag": {
      const from = pointOf(found);
      if (cmd.to === undefined) throw new Error("do:drag без to — куда тащить");
      const dest = await findTarget(cmd.to, Date.now() + DRAG_FIND_MS);
      const to = pointOf(dest);
      await mouse({ op: "drag", x: from.x, y: from.y, toX: to.x, toY: to.y, space: "screen" });
      return { did: `перетащил «${found.name}» → «${dest.name}» (${at(from)} → ${at(to)})`, physical: true };
    }
    default: {
      const _x: never = verb;
      throw new Error(`неизвестный глагол указателя: ${String(_x)}`);
    }
  }
}

/**
 * W2 П1 (безопасность №11): ФИЗИЧЕСКИЙ клик по handle в рискованной программе — в ТОЧКУ, которую рубеж судит.
 *
 * Сайдкар кликает handle в его «clickable point» — а поверх элемента может лежать другой (всплывашка, оверлей чата):
 * рубеж судил бы «Поиск» из зеркала, а нажалось бы то, что сверху. Поэтому в мессенджере/банке/ЭДО/браузере клик по
 * handle превращается в клик по центру его bbox, и судится элемент ПОД этой точкой (`ground.at`). В обычных
 * программах — как прежде (по handle).
 */
import { guiProcessCategory } from "@jarvis/shared";
import type { Point } from "./coords.js";
import { createInjectionFacts } from "./injection-facts.js";
import { bboxCenterDip, handleOf, mirrorLookup } from "./process-of.js";

/**
 * Точка (DIP) для физического клика по handle: процесс рискованный ИЛИ поверх центра элемента чужое окно (клик попал
 * бы в него — рубеж судит то, что сверху); иначе null — клик по handle, как прежде.
 */
export async function riskyHandlePoint(handle: string): Promise<Point | null> {
  const e = mirrorLookup(handle);
  const c = e ? bboxCenterDip(e.bbox) : null;
  if (!e || !c) return null;
  const f = createInjectionFacts();
  const proc = await handleOf(f, e);
  const cat = proc ? guiProcessCategory(proc.process, proc.title) : null;
  if (cat && cat.category !== "remote") return c;
  const top = await f.windowAt(c);
  return proc && top && top.pid !== proc.pid ? c : null;
}

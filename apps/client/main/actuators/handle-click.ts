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

/** Точка (DIP) для физического клика по handle, если его процесс рискованный; иначе null — клик по handle. */
export async function riskyHandlePoint(handle: string): Promise<Point | null> {
  const e = mirrorLookup(handle);
  const c = e ? bboxCenterDip(e.bbox) : null;
  if (!e || !c) return null;
  const proc = await handleOf(createInjectionFacts(), e);
  const cat = proc ? guiProcessCategory(proc.process, proc.title) : null;
  return cat && cat.category !== "remote" ? c : null;
}

/**
 * W2 П1 (безопасность №4): ПЕРЕСВЕРКА устаревшей записи зеркала handle перед судом §14.
 *
 * Снапшот-1 дал handle 41 «Записать голосовое»; модель напечатала текст — и на ТОМ ЖЕ месте (тот же UIA-элемент,
 * тот же handle) теперь «Отправить». Суд по старому имени пропустил бы отправку (или списал бы чужой грант). Поэтому
 * запись, устаревшая (20 с или инжекция в её процесс), в рискованной программе пересверяется: пересъёмка снапшота
 * процесса, поиск того же элемента по (роль, automationId, bbox ± 8 px) и суд по ТЕКУЩЕМУ имени. Не нашёлся →
 * null: рубеж отказывает fail-closed («элемент изменился — сними снапшот заново»).
 */
import type { ElementFacts } from "@jarvis/shared";
import { normRole } from "@jarvis/shared";
import type { MirrorEntry } from "./handle-mirror.js";
import { uiSnapshot } from "./ground.js";

const BBOX_TOLERANCE_PX = 8;
const RECHECK_MAX_ITEMS = 200;

const near = (a: number, b: number): boolean => Math.abs(a - b) <= BBOX_TOLERANCE_PX;

/** Текущие имя и роль элемента из свежего снапшота его процесса; не найден/снапшот не снялся — null. */
export async function recheckElement(e: MirrorEntry, pid: number): Promise<ElementFacts | null> {
  let items;
  try {
    items = (await uiSnapshot(pid, RECHECK_MAX_ITEMS)).items;
  } catch {
    return null;
  }
  const role = normRole(e.role);
  const hit = items.find(
    (it) =>
      normRole(it.role) === role &&
      (e.automationId ? it.automationId === e.automationId : true) &&
      near(it.x, e.bbox.x) && near(it.y, e.bbox.y) && near(it.w, e.bbox.w) && near(it.h, e.bbox.h),
  );
  return hit ? { name: hit.name, role: hit.role } : null;
}

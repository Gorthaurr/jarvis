/**
 * W2 П1 (G-22): локальный вид моста `ui.find` — поиск цели для SDK `jarvis.find()` ТОЙ ЖЕ лестницей, что у act
 * (act-find.findTarget: снапшот UIA с ранжированием точное > префикс > подстрока, затем OCR).
 *
 * Прежний `find` на python брал ПЕРВОЕ совпадение подстрокой: «Отправить файл» стоял в снапшоте раньше «Отправить» —
 * и нажимался он. Теперь точное имя побеждает, а два РАВНЫХ кандидата — честная ошибка со списком видимого (модель
 * уточняет), а не клик наугад. Свои окна Джарвиса целью не бывают (act-find). Действие по найденному — обычными
 * командами моста (invoke по handle / click по точке), и каждое судит рубеж инжекции.
 */
import type { ActionResult } from "@jarvis/protocol";
import { selectionStore } from "../selection/store.js";
import { ActFindError, findTarget } from "./act-find.js";

/** Бюджет поиска (снапшот UIA до 12 с + OCR). */
const FIND_BUDGET_MS = 25_000;
/** «Не найдено» (а не неоднозначность/своё окно): SDK отдаёт пустой Element — скрипт проверяет `if el:`. */
const NOT_FOUND_RE = /не найдена|в UIA-снапшоте нет/u;

export interface BridgeFindQuery {
  text?: unknown;
  role?: unknown;
  automationId?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Исполнить `ui.find` моста → ActionResult (данные — для python Element). */
export async function bridgeFind(commandId: string, q: BridgeFindQuery): Promise<ActionResult> {
  const t0 = Date.now();
  const text = str(q.text);
  const role = str(q.role);
  const automationId = str(q.automationId);
  if (!text && !role && !automationId) {
    return { commandId, ok: false, error: { code: "runtime", message: "ui.find: нужен text, role или automationId" }, durationMs: 0 };
  }
  // Под вуалью режима выделения активное окно — оверлей: искать нечего (SDK выходит кодом 77, а не «не нашёл»).
  const veil = selectionStore.physicalInputBlockReason();
  if (veil) return { commandId, ok: false, error: { code: "overlay_drawing", message: `ui.find: ${veil}` }, durationMs: 0 };
  try {
    const f = await findTarget({ ...(text ? { text } : {}), ...(role ? { role } : {}), ...(automationId ? { automationId } : {}) }, t0 + FIND_BUDGET_MS);
    const data = {
      via: f.via,
      name: f.name,
      ...(f.role ? { role: f.role } : {}),
      ...(f.handle ? { handle: f.handle } : {}),
      // Точка (OCR/под точкой без элемента) — абсолютные экранные DIP: SDK кликает её с space="screen".
      ...(f.point ? { x: f.point.x, y: f.point.y, space: "screen" } : {}),
      ...(f.note ? { note: f.note } : {}),
    };
    return { commandId, ok: true, data, durationMs: Date.now() - t0 };
  } catch (e) {
    const message = `ui.find: ${e instanceof Error ? e.message : String(e)}`;
    if (e instanceof ActFindError && NOT_FOUND_RE.test(e.message)) return { commandId, ok: true, data: { found: false, note: message }, durationMs: Date.now() - t0 };
    return { commandId, ok: false, error: { code: "not_found", message }, durationMs: Date.now() - t0 };
  }
}

/**
 * browser_batch (W1) на уровне service worker — чистые куски без chrome-API: разбор шагов и правило остановки.
 * Вынесено из god-file background.js (закон 3); tabBatch там только исполняет шаги через tabAct.
 */
import { parseRef } from "./utils.js";

export const BATCH_MAX_STEPS = 12;

/** Шаги модели → [{intent, params, frame, localRef}] | {error, code?} (ошибка — ДО первого действия). */
export function parseBatchSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return { error: "batch: пустой список шагов" };
  if (steps.length > BATCH_MAX_STEPS) return { error: "batch: максимум " + BATCH_MAX_STEPS + " шагов за раз (разбей длинный флоу)" };
  const parsed = [];
  for (const s of steps) {
    const o = s && typeof s === "object" ? s : {};
    const intent = String(o.intent || o.action || "");
    if (!intent) return { error: "batch: шаг без intent" };
    const P = o.params && typeof o.params === "object" ? { ...o.params } : { ...o };
    for (const k of ["ref", "selector"]) if (o[k] != null && P[k] == null) P[k] = o[k];
    if (typeof o.text === "string" && o.params && typeof o.params === "object") {
      if (intent !== "type") { if (P.text == null) P.text = o.text; }
      else if (P.text !== o.text) P.label = o.text; // type: верхний text — подпись поля, params.text — что печатать
    }
    let frame = 0;
    let localRef = null;
    if (P.ref != null && String(P.ref).trim()) {
      const pr = parseRef(P.ref);
      if (!pr) return { code: "ref_stale", error: "batch: шаг «" + intent + "» с некорректным ref — сделай browser_inspect заново" };
      frame = pr.frame || 0;
      localRef = pr.localRef;
    }
    parsed.push({ intent, params: P, frame, localRef });
  }
  return { parsed };
}

/**
 * Шаг выполнен, но страница УШЛА (navigated) или исход не подтверждён (uncertain), а шаги ещё есть → стоп: следующие
 * selector/text-шаги ударили бы по НОВОЙ странице, а «не знаю, сработало ли» не превращается в «берст выполнен».
 * Последний шаг так не стопится — его исход (с uncertain/navigated) отдаётся как есть. Возвращает ответ-стоп или null.
 */
export function batchStepStop(i, intent, r, total, results) {
  if (i >= total - 1 || !r || typeof r !== "object" || !(r.uncertain || r.navigated)) return null;
  const why = r.uncertain ? "исход не подтверждён (страница перешла во время действия)" : "страница перешла на другой адрес";
  return {
    ok: false, code: "uncertain", stoppedAt: i, done: i + 1, total, results,
    error: "uncertain: шаг " + (i + 1) + " («" + intent + "») — " + why + "; остальные шаги НЕ выполнены. Сверь страницу (browser_inspect), вслепую не повторяй",
  };
}

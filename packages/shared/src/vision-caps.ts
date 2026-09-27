/**
 * W2 (пакет 0, решение №8): КАП КАДРА по зрению семейства модели — данные, без флага.
 *
 * Справочник claude-api (кеш 2026-06-24): высокое разрешение — Opus 4.7/4.8/5/5.5, Sonnet 5, Fable 5/5.1: длинная
 * сторона ≤ 2576 px, ≤ 3,75 Мп, координаты модели 1:1 с пикселями картинки. Стандартное — Opus ≤ 4.6, Sonnet 4.6,
 * Haiku 4.5: 1568 px, консервативно 1,15 Мп. Computer use: 1080p — «хороший баланс» → кадр по умолчанию на high —
 * 1920 (решение владельца №2), деталь добирается зумом до maxEdge.
 * Неизвестная модель → std (узкая сторона безопасна: картинку не пережмут молча на стороне API).
 */

export type VisionLevel = "high" | "std";

export interface VisionCap {
  /** Длинная сторона полного кадра задачи по умолчанию. */
  frameEdge: number;
  /** Потолок длинной стороны любой картинки (зум). */
  maxEdge: number;
  /** Потолок площади картинки. */
  maxPixels: number;
}

export const VISION_CAPS: Readonly<Record<VisionLevel, VisionCap>> = {
  high: { frameEdge: 1920, maxEdge: 2576, maxPixels: 3_750_000 },
  std: { frameEdge: 1568, maxEdge: 1568, maxPixels: 1_150_000 },
};

/** Уровень зрения по id модели (API-id, алиас подписки, Bedrock-префикс; суффикс контекста `[1m]` срезается). */
export function visionLevel(modelId: string | null | undefined): VisionLevel {
  const id = String(modelId ?? "").trim().toLowerCase().replace(/\[1m\]$/u, "");
  if (id === "opus" || id === "fable") return "high";
  if (!id || id === "haiku" || id === "sonnet") return "std"; // голый «sonnet» — поколение неизвестно, консервативно
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d{1,2})(?!\d))?/u.exec(id);
  if (!m) return "std";
  const family = m[1]!;
  const gen = Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
  if (family === "fable") return "high";
  if (family === "opus") return gen >= 4.7 ? "high" : "std";
  if (family === "sonnet") return gen >= 5 ? "high" : "std";
  return "std";
}

/** Кап для набора моделей задачи (подписка ∪ тиры API): поэлементный минимум — картинку увидит любая из них. */
export function visionCapFor(ids: ReadonlyArray<string | null | undefined>): VisionCap {
  const caps = ids.filter((i) => i && String(i).trim()).map((i) => VISION_CAPS[visionLevel(i)]);
  if (caps.length === 0) return { ...VISION_CAPS.std };
  return {
    frameEdge: Math.min(...caps.map((c) => c.frameEdge)),
    maxEdge: Math.min(...caps.map((c) => c.maxEdge)),
    maxPixels: Math.min(...caps.map((c) => c.maxPixels)),
  };
}

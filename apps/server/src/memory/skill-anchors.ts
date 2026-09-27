/**
 * Якоря навыка (27.09, адверс-ревью р1): детерминированный признак «реплика — про ЭТОТ навык» для гейта подсказки
 * (loop/retrieval.ts), когда сырой косинус e5-small ниже порога. Разрешения модели не хватает: заглавная буква и
 * точка в конце сдвигают косинус на 0.01–0.02, а приказ владельца «Пройди все мини-тесты…» в формах STT шёл 0.84–0.86
 * при пороге 0.86 — подсказка то была, то нет, и модель по 4 раунда искала, что за портал.
 *
 * Знание о программе — данные навыка (закон 2), не код: frontmatter `anchors: эиос | учебн портал`. Якорь — основы
 * через пробел, ВСЕ обязаны встретиться в реплике (регистр и ё не важны). Ложное срабатывание дешёвое: якорь только
 * снимает порог косинуса у навыка, который recall УЖЕ выбрал, в реплике с командным глаголом.
 */

const norm = (s: string): string => s.toLowerCase().replace(/ё/gu, "е");

/** `эиос | учебн портал` (строка frontmatter) или массив → нормализованные якоря; мусор → []. */
export function parseAnchors(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split("|") : [];
  return parts.map((p) => norm(p).replace(/\s+/gu, " ").trim()).filter((p) => p.length >= 3);
}

/** Встретился ли в реплике хоть один якорь целиком (все его основы). */
export function anchorHit(anchors: readonly string[] | undefined, text: string): boolean {
  if (!anchors?.length) return false;
  const t = norm(text);
  return anchors.some((a) => a.split(" ").every((stem) => t.includes(stem)));
}

/** Строка frontmatter для serializeLearnedSkill (пусто — без строки). */
export function anchorsLine(anchors: readonly string[] | undefined): string[] {
  const list = parseAnchors(anchors ?? []);
  return list.length ? [`anchors: ${list.join(" | ")}`] : [];
}

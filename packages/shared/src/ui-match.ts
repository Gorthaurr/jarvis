/**
 * Матч кликабельного элемента по ТЕКСТУ — для ОБЩЕГО model-driven пути (browser_act, §6, Фаза 5).
 *
 * Корень бага (аудит): общий `byText` кликал по `text.includes(query)` — короткий запрос даёт опасные
 * ложные попадания: «да» матчит «Удалить» (`удалить`.includes(`да`)=true) → клик НЕ ТУДА (удаление вместо
 * подтверждения). Здесь робастный скоринг: точное > целое-слово > префикс > подстрока, причём короткий
 * запрос (≤3 симв.) матчится ТОЛЬКО точно/целым словом (никакой подстроки) — «да» больше не цепляет
 * «Удалить». Чистая функция → юнит-тест; DOM-склейка остаётся тонкой (передаёт тексты сюда).
 */
import { foldName } from "./name-match.js";

export interface ClickCandidate {
  /** Видимый текст элемента (innerText/value). */
  text: string;
  /** aria-label/title — учитывается наравне с текстом. */
  aria?: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Индекс ЛУЧШЕГО кандидата под запрос (или -1). fold (регистр/диакритика/пунктуация) с обеих сторон.
 * Короткий запрос (≤3 симв.) — без подстрочного матча (иначе «да»→«Удалить», «ок»→«Блокировать»).
 */
export function bestTextMatch(query: string, candidates: readonly ClickCandidate[]): number {
  const q = foldName(query);
  if (!q) return -1;
  const short = q.length <= 3;
  const word = new RegExp(`(^| )${escapeRe(q)}( |$)`);
  let best = -1;
  let bestScore = 0;
  candidates.forEach((c, i) => {
    const hay = foldName(`${c.text} ${c.aria ?? ""}`);
    if (!hay) return;
    let score = 0;
    if (hay === q) score = 100; // точное
    else if (word.test(hay)) score = 80; // целое слово в тексте
    else if (!short && hay.startsWith(q)) score = 60; // начинается с (только не-короткий)
    else if (!short && q.length >= 4 && hay.includes(q)) score = 30; // подстрока — лишь для запросов ≥4
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return bestScore > 0 ? best : -1;
}

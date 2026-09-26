/**
 * W1 «браузерные руки»: ФОРМА аргументов browser_act / шага browser_batch — одно место для хендлера, §14-гейта и
 * §0-гарда учётных данных. Разойдись они, гард читал бы одно поле, а расширение печатало бы другое (грабли проекта:
 * гейт читал `key`, схема слала `combo`; гейт берста смотрел на верх шага, а расширение — в params).
 *
 * Модель шлёт поля плоско рядом с intent (схема W1: `browser_act{intent, ref, value}`) или в `params:{…}` (навыки и
 * прежняя форма) — принимаем обе; при конфликте побеждает `params`. Служебные поля §14 (guard/guardApproved/
 * approvedLabel) ставит ТОЛЬКО сервер: от модели их вырезаем, иначе инъекция со страницы велела бы прислать
 * guardApproved:true.
 */

const SERVER_ONLY = new Set(["guard", "guardApproved", "approvedLabel"]);

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function withoutServerOnly(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!SERVER_ONLY.has(k)) out[k] = v;
  return out;
}

/** Параметры browser_act: плоские поля (кроме intent/url/tabId) + params поверх; служебные поля §14 вырезаны. */
export function browserActParams(input: Record<string, unknown>): Record<string, unknown> {
  const { intent: _i, url: _u, tabId: _t, params, ...flat } = input;
  return withoutServerOnly({ ...flat, ...(asRecord(params) ?? {}) });
}

/** Шаг берста: поля с верха шага + params поверх (так их читает расширение), без служебных полей §14. */
export function browserStepFields(step: unknown): { intent: string; fields: Record<string, unknown> } {
  const o = asRecord(step) ?? {};
  const { params, intent, action, ...top } = o;
  const fields = withoutServerOnly({ ...top, ...(asRecord(params) ?? {}) });
  return { intent: String(intent ?? action ?? "").trim(), fields };
}

/**
 * Интенты, которые НИЧЕГО не меняют на странице (наведение, прокрутка, служебные чтения). Всё прочее — меняющее:
 * таймаут после отправки у него = «исход неизвестен» (B-4). Позитивный список безопасных — незнакомый интент считается
 * меняющим (лишнее «сверь» дешевле ложного «не вышло» и повтора).
 */
const NON_MUTATING_INTENTS: ReadonlySet<string> = new Set(["hover", "scroll_to", "scroll", "getValue", "readMedia"]);

export function intentMayMutate(intent: string): boolean {
  return !NON_MUTATING_INTENTS.has(intent.trim());
}

/** Интенты без клика по цели: гард подписи странице не нужен (hover — наведение, scroll_to — прокрутка, контракт §7). */
const GUARDLESS_INTENTS: ReadonlySet<string> = new Set(["hover", "scroll_to"]);

export function intentNeedsPageGuard(intent: string): boolean {
  return !GUARDLESS_INTENTS.has(intent.trim());
}

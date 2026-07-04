/**
 * Резолв контактов и голосовая дизамбигуация (§13).
 *
 * «Ответь Маше» → ищем по display_name и aliases. Несколько совпадений →
 * голосовая дизамбигуация («какой Маше — Ивановой или из зала?»), не угадывание (§13).
 * aliases пополняет ночная консолидация из наблюдаемой переписки (§8/§13).
 */
import type { MessageChannel } from "@jarvis/protocol";

export interface Contact {
  id: string;
  displayName: string;
  aliases: string[];
  /** Адрес per-канал: {telegram:"@user", vk:"id123"}. */
  channels: Partial<Record<MessageChannel, string>>;
}

export type ResolveResult =
  | { kind: "match"; contact: Contact }
  | { kind: "ambiguous"; candidates: Contact[] }
  | { kind: "none" };

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Совпадает ли запрос с контактом (по имени или алиасу). */
function matches(query: string, c: Contact): boolean {
  const q = norm(query);
  // FAIL-CLOSED: пустой запрос (тишина/обрыв STT) НЕ матчит никого — иначе `…includes("")===true`
  // делал адресатом любого/единственного контакта → сообщение НЕ ТОМУ человеку. Подстрочный матч
  // разрешаем только для запросов ≥2 символов (1 символ тоже даёт массовые ложные совпадения).
  if (q.length === 0) return false;
  if (norm(c.displayName) === q) return true;
  const allowSubstr = q.length >= 2;
  if (allowSubstr && norm(c.displayName).includes(q)) return true;
  return c.aliases.some((a) => norm(a) === q || (allowSubstr && norm(a).includes(q)));
}

/**
 * Разрешить контакт по запросу. Один → match; несколько → ambiguous (дизамбигуация);
 * ноль → none. Канал учитывается: контакт без адреса в нужном канале не подходит.
 */
export function resolveContact(query: string, contacts: readonly Contact[], channel?: MessageChannel): ResolveResult {
  let candidates = contacts.filter((c) => matches(query, c));
  if (channel) candidates = candidates.filter((c) => Boolean(c.channels[channel]));

  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "match", contact: candidates[0]! };
  // Точное совпадение по полному имени имеет приоритет над частичными.
  const exact = candidates.filter((c) => norm(c.displayName) === norm(query));
  if (exact.length === 1) return { kind: "match", contact: exact[0]! };
  return { kind: "ambiguous", candidates };
}

/** Фраза дизамбигуации для голоса (§13): «Маша Иванова или Маша из зала?». */
export function disambiguationPrompt(query: string, candidates: readonly Contact[]): string {
  const names = candidates.map((c) => c.displayName);
  const list = names.length === 2 ? names.join(" или ") : `${names.slice(0, -1).join(", ")} или ${names.at(-1)}`;
  return `Какому контакту «${query}» — ${list}?`;
}

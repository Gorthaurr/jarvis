/**
 * W1-ревью р2 (контракт клавиш): ОДИН разбор строки combo для §14-гейта сервера, клиентского рубежа и петли —
 * зеркало `parseCombo` расширения (apps/extension/background.js, elementActIsolated). Разойдись они, гейт судил бы
 * одну клавишу, а страница жала бы другую («Space+Enter»: гейт — «не Enter», расширение — голый Enter в мессенджер).
 * Стык закреплён таблицей apps/extension/test/fixtures/key-combos.json — по ней тест и на сервере, и на стенде.
 *
 * Правило: split('+'), trim, пустые части отбросить; модификаторы — ctrl/control, alt/option, shift,
 * meta/cmd/command/win/super; ровно ОДНА не-модификаторная клавиша в любом порядке. Больше одной («a+Enter»,
 * «Enter+Enter») или ни одной — combo недействителен (расширение отвечает invalid_combo и ничего не жмёт).
 */

export interface KeyCombo {
  /** Каноническое имя клавиши: enter, space, tab, escape, arrowdown, f5… или один символ в нижнем регистре. */
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

const MODIFIERS: Readonly<Record<string, "ctrl" | "shift" | "alt" | "meta">> = {
  ctrl: "ctrl", control: "ctrl", shift: "shift", alt: "alt", option: "alt",
  meta: "meta", cmd: "meta", command: "meta", win: "meta", super: "meta",
};

/** Имена клавиш (синонимы → каноническое) — те же, что понимает расширение (NAMED в elementActIsolated). */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: "enter", return: "enter", tab: "tab", escape: "escape", esc: "escape", space: "space", spacebar: "space",
  backspace: "backspace", delete: "delete", del: "delete", arrowdown: "arrowdown", down: "arrowdown", arrowup: "arrowup",
  up: "arrowup", arrowleft: "arrowleft", left: "arrowleft", arrowright: "arrowright", right: "arrowright",
  home: "home", end: "end", pageup: "pageup", pagedown: "pagedown",
};

/** Имя клавиши → каноническое; незнакомое имя (не F1–F12 и не один символ) → null. */
export function canonicalKeyName(part: string): string | null {
  const l = part.trim().toLowerCase();
  if (NAMED_KEYS[l]) return NAMED_KEYS[l];
  if (/^f(?:[1-9]|1[0-2])$/u.test(l)) return l;
  return l.length === 1 ? l : null; // один символ, как `key.length !== 1` у расширения (UTF-16)
}

/** Разобрать combo. null — недействителен: нет клавиши, больше одной клавиши или незнакомое имя. */
export function parseKeyCombo(combo: string): KeyCombo | null {
  const out: KeyCombo = { key: "", ctrl: false, shift: false, alt: false, meta: false };
  let keys = 0;
  for (const part of String(combo ?? "").split("+").map((s) => s.trim()).filter(Boolean)) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (mod) {
      out[mod] = true;
      continue;
    }
    keys += 1;
    out.key = canonicalKeyName(part) ?? "";
  }
  return keys === 1 && out.key ? out : null;
}

/**
 * Хоть одна не-модификаторная часть — Enter/Return (даже в недействительном combo): старое расширение («последняя
 * клавиша побеждает») нажало бы Enter в «a+Enter», поэтому гейт судит такую строку как коммит (fail-closed).
 */
export function comboMentionsEnter(combo: string): boolean {
  return String(combo ?? "").split("+").some((p) => !MODIFIERS[p.trim().toLowerCase()] && canonicalKeyName(p) === "enter");
}

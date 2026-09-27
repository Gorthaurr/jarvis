/**
 * W3 (L-10): строка КАТАЛОГА холодного инструмента — всё, что модель знает о нём до tool_load.
 *
 * Прежний `toolCatalogLine` резал описание по первой «. », «—» или переводу строки и до 100 символов: предусловия
 * терялись («web_login: ВХОД В СЕРВИС», «app_channel_learn: ЗАПОМНИТЬ программный канал приложения» — без «только
 * по факту пробы»), а обрыв посреди скобки оставлял висячее «(hover», «(из look{what:'windows'}». Теперь: служебные
 * пометки `(ActionCommand …)`/`(§…)` вырезаются, фразы добираются целиком до {@link CATALOG_LINE_MAX}, незакрытые
 * скобки/кавычки отрезаются. Где первая фраза всё равно не несёт условие применения — явная строка в CATALOG_HINTS
 * (НЕ поле ToolSchema: схема уходит в API, подсказка — только в каталог).
 */

/** Потолок описательной части строки каталога (без «- имя: »). */
export const CATALOG_LINE_MAX = 160;

/** Явные строки каталога: условие применения, которое первая фраза описания не несёт. */
export const CATALOG_HINTS: Readonly<Record<string, string>> = {
  app_channel_learn:
    "запомнить программный канал приложения (URI/CLI/API) ТОЛЬКО по факту: дай probe — сервер выполнит и запишет рецепт лишь при успехе; нужны verify и limits",
  web_login:
    "невидимый браузер НЕ залогинен (web_read: форма входа/loginWall) → открыть вход ВИДИМО; владелец входит сам (пароль не вводишь), потом снова web_open",
  web_inspect:
    "элементы страницы невидимого браузера с селекторами — то же, что горячий web_read{view:'elements', query}; зови его, tool_load не нужен",
  input_click: "клик по цели/точке без курсора (UIA под точкой; physical — игры/canvas), count=2 — дабл-клик; обычно хватает act",
  app_focus: "фокус уже запущенного приложения — то же, что горячий window{op:'focus', query}; закрыть — app_close",
  monitor_assign: "ПОСТОЯННО назначить рабочий монитор Джарвиса («работай на втором»): сперва номера через monitor_list, index=null — авто",
  trade_predict:
    "записать прогноз-сделку (направление + stopPrice + targetPrice, R:R ≥ 2:1) после market_analyze и knowledge_consult; денег не двигает",
};

/** Служебные пометки описаний: модели в каталоге не нужны, место съедают. */
const NOISE_RE = /\s*\((?:ActionCommand [^)]*|§[^)]{0,40})\)|§Волна\d\s*(?:\([^)]*\))?,?\s*/gu;
const PAIRS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}", "«": "»" };
const CLOSERS = new Set(Object.values(PAIRS));

/** Позиция первого НЕзакрытого открывающего знака (скобки/«ёлочки») или непарной прямой кавычки; -1 — всё сбалансировано. */
export function firstUnbalanced(text: string): number {
  const stack: number[] = [];
  const quotes: Record<string, number[]> = { '"': [], "'": [], "`": [] };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch in PAIRS) stack.push(i);
    else if (CLOSERS.has(ch)) {
      const open = stack.at(-1);
      if (open !== undefined && PAIRS[text[open]!] === ch) stack.pop();
      else return i; // лишняя закрывающая — тоже дефект строки
    } else if (ch in quotes && !(ch === "'" && /\p{L}/u.test(text[i - 1] ?? "") && /\p{L}/u.test(text[i + 1] ?? ""))) {
      quotes[ch]!.push(i);
    }
  }
  const oddQuote = Object.values(quotes).filter((q) => q.length % 2 === 1).map((q) => q.at(-1)!);
  const cands = [...(stack.length ? [stack[0]!] : []), ...oddQuote];
  return cands.length ? Math.min(...cands) : -1;
}

/** Отрезать хвост с первого незакрытого знака и висячие разделители. */
function balanced(text: string): string {
  let out = text;
  for (let pos = firstUnbalanced(out); pos >= 0; pos = firstUnbalanced(out)) out = out.slice(0, pos);
  return out.replace(/[\s,;:—–-]+$/u, "").trim();
}

/** Описательная часть строки каталога: целые фразы до max, без служебных пометок и висячих скобок. */
export function catalogSummary(description: string, max = CATALOG_LINE_MAX): string {
  const clean = String(description || "").replace(NOISE_RE, " ").replace(/\s+/gu, " ").replace(/ ([.,:;])/gu, "$1").trim();
  // Граница фразы — знак конца + пробел + заглавная (не «напр. https», не «вкл. фьючерсы»).
  const sentences = clean.split(/(?<=[.!?])\s+(?=[\p{Lu}«"🔴⚠])/u);
  let out = "";
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > max) break;
    out = next;
  }
  if (!out) {
    // Первая «фраза» длиннее потолка: сперва граница «. » внутри (фраза со строчной), иначе — по слову, с «…».
    const head = (sentences[0] ?? "").slice(0, max - 1);
    const dot = head.lastIndexOf(". ");
    if (dot > max / 3) return balanced(head.slice(0, dot + 1));
    const cut = head.lastIndexOf(" ") > max / 2 ? head.slice(0, head.lastIndexOf(" ")) : head;
    return `${balanced(cut)}…`;
  }
  return balanced(out);
}

/** Однострочник инструмента для каталога «по запросу» (§15): имя + условие применения. */
export function toolCatalogLine(t: { name: string; description: string }): string {
  return `- ${t.name}: ${CATALOG_HINTS[t.name] ?? catalogSummary(t.description)}`;
}

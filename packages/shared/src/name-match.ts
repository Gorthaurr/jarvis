/**
 * Сопоставление ИМЁН/получателей — кросс-скрипт и нечётко (§13, Telegram-резолв).
 *
 * ФИЛОСОФИЯ (главное): «Герман» (как говорит владелец) и «Herman» (как сохранён контакт в
 * Telegram) — РАЗНЫЕ алфавиты; тупой includes/=== их не свяжет, а простая транслитерация Г→G
 * даст «German», а не «Herman» (русское Г передаёт чужое H: Гамбург=Hamburg). РЕШЕНИЕ «Герман =
 * Herman» — это ЗНАНИЕ модели (Opus), а не таблицы. Поэтому здесь:
 *
 *   • транслитерация — ТОЛЬКО для RECALL: расширить поисковый запрос так, чтобы кросс-скриптовый
 *     контакт ВООБЩЕ всплыл в списке кандидатов (иначе модели нечего выбирать);
 *   • РЕШЕНИЕ — за моделью: `pickRecipient` авто-отправляет лишь на ОДНОЗНАЧНОМ совпадении
 *     (один и тот же алфавит, точное/префиксное, ИЛИ единственный транслит-кандидат); любая
 *     неоднозначность → `ask` → агент (LLM) выбирает по смыслу и шлёт точное имя.
 *
 * Чистый модуль без DOM/IO → полностью покрыт юнит-тестами; DOM-склейка (webK) тонкая.
 */

// ── нормализация ─────────────────────────────────────────────

/** Свернуть имя для сравнения: нижний регистр, без диакритики, ё→е, схлоп пробелов, обрезка пунктуации по краям. */
export function foldName(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // комбинирующие диакритики (é→e)
    .toLowerCase()
    .replace(/[ё"']/g, (m) => (m === "ё" ? "е" : "")) // ё→е, кавычки прочь

    .replace(/[^\p{L}\p{N}\s]+/gu, " ") // не-буквы/цифры → пробел (эмодзи, пунктуация)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Свернуть ТЕКСТ для матча по словам (единый источник для tasks/scope, tasks/control, knowledge):
 * нижний регистр, ё→е, всё не-[a-z0-9а-я] → пробел, схлоп пробелов. `pad:true` окаймляет пробелами —
 * тогда проверка границ через " слово " работает и для кириллицы. Уже foldName (шире, unicode) — для ИМЁН;
 * этот — для лексического матча команд/тем (узкий латиница+кириллица+цифры, как было в дублях).
 */
export function foldText(text: string, opts: { pad?: boolean } = {}): string {
  const cleaned = String(text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-z0-9а-я]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!opts.pad) return cleaned;
  return cleaned.length > 0 ? ` ${cleaned} ` : "";
}

type Script = "cyr" | "lat" | "mixed" | "other";

/** Преобладающий алфавит строки (по буквам). */
export function scriptOf(s: string): Script {
  let cyr = 0;
  let lat = 0;
  for (const ch of String(s ?? "")) {
    if (/[Ѐ-ӿ]/.test(ch)) cyr += 1;
    else if (/[a-z]/i.test(ch)) lat += 1;
  }
  if (cyr && lat) return "mixed";
  if (cyr) return "cyr";
  if (lat) return "lat";
  return "other";
}

// ── транслитерация (recall) ──────────────────────────────────

/** RU→LAT: primary = самый частый рендеринг; alts = высокосигнальные альтернативы (включая Г→h). */
const RU2LAT: Record<string, { p: string; alts?: string[] }> = {
  а: { p: "a" }, б: { p: "b" }, в: { p: "v", alts: ["w"] },
  г: { p: "g", alts: ["h"] }, // ключ: Гамбург=Hamburg, Герман=Herman
  д: { p: "d" }, е: { p: "e", alts: ["ye"] }, ё: { p: "e", alts: ["yo"] },
  ж: { p: "zh", alts: ["j"] }, з: { p: "z" }, и: { p: "i", alts: ["y"] },
  й: { p: "y", alts: ["i"] }, к: { p: "k", alts: ["c"] }, л: { p: "l" },
  м: { p: "m" }, н: { p: "n" }, о: { p: "o" }, п: { p: "p" }, р: { p: "r" },
  с: { p: "s" }, т: { p: "t" }, у: { p: "u", alts: ["oo"] }, ф: { p: "f" },
  х: { p: "kh", alts: ["h", "x"] }, ц: { p: "ts", alts: ["c"] },
  ч: { p: "ch" }, ш: { p: "sh" }, щ: { p: "shch", alts: ["sch"] },
  ъ: { p: "" }, ы: { p: "y", alts: ["i"] }, ь: { p: "" }, э: { p: "e" },
  ю: { p: "yu", alts: ["u", "iu"] }, я: { p: "ya", alts: ["ia", "a"] },
};

/** LAT→RU: диграфы важнее одиночных (порядок проверки — длинные сперва). */
const LAT_DIGRAPHS: Array<[string, { p: string; alts?: string[] }]> = [
  ["shch", { p: "щ" }], ["sch", { p: "щ" }], ["zh", { p: "ж" }], ["kh", { p: "х" }],
  ["sh", { p: "ш" }], ["ch", { p: "ч" }], ["ts", { p: "ц" }], ["yu", { p: "ю" }],
  ["ya", { p: "я" }], ["yo", { p: "ё" }], ["ye", { p: "е" }], ["oo", { p: "у" }],
];
const LAT_SINGLE: Record<string, { p: string; alts?: string[] }> = {
  a: { p: "а" }, b: { p: "б" }, c: { p: "к", alts: ["ц", "с"] }, d: { p: "д" },
  e: { p: "е", alts: ["э"] }, f: { p: "ф" }, g: { p: "г" },
  h: { p: "х", alts: ["г"] }, // обратная сторона Г↔H: Herman→Герман
  i: { p: "и" }, j: { p: "дж", alts: ["й", "ж"] }, k: { p: "к" }, l: { p: "л" },
  m: { p: "м" }, n: { p: "н" }, o: { p: "о" }, p: { p: "п" }, q: { p: "к" },
  r: { p: "р" }, s: { p: "с" }, t: { p: "т" }, u: { p: "у" }, v: { p: "в" },
  w: { p: "в" }, x: { p: "кс" }, y: { p: "й", alts: ["ы", "и"] }, z: { p: "з" },
};

const MAX_VARIANTS = 6;

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const k = s.toLowerCase();
    if (s && !seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/** Разложить строку на «буквы» по таблице: для LAT — с учётом диграфов. */
function tokenizeLat(s: string): Array<{ p: string; alts?: string[] }> {
  const out: Array<{ p: string; alts?: string[] }> = [];
  let i = 0;
  const low = s.toLowerCase();
  outer: while (i < low.length) {
    for (const [dg, v] of LAT_DIGRAPHS) {
      if (low.startsWith(dg, i)) {
        out.push(v);
        i += dg.length;
        continue outer;
      }
    }
    const ch = low[i]!;
    out.push(LAT_SINGLE[ch] ?? { p: ch });
    i += 1;
  }
  return out;
}

/**
 * Транслитерировать имя в чужой алфавит — упорядоченный список вариантов для ПОИСКА (recall).
 * primary (частый рендеринг) первым, затем одиночные свопы высокосигнальных букв (Г→h и т.п.),
 * затем — для коротких имён — пара двойных свопов. Капается (MAX_VARIANTS). НЕ для решения!
 */
export function transliterate(name: string): string[] {
  const s = foldName(name);
  if (!s) return [];
  const sc = scriptOf(s);
  let letters: Array<{ p: string; alts?: string[] }>;
  if (sc === "cyr") letters = [...s].map((ch) => (ch === " " ? { p: " " } : (RU2LAT[ch] ?? { p: ch })));
  else if (sc === "lat") letters = tokenizeLat(s);
  else return []; // mixed/other → нечего расширять

  const base = letters.map((l) => l.p).join("");
  const variants: string[] = [base];

  // одиночные свопы: для каждой буквы с alts — заменить ТОЛЬКО её (из base), от частых к редким
  const swapPositions: number[] = [];
  letters.forEach((l, idx) => {
    if (l.alts && l.alts.length) swapPositions.push(idx);
  });
  for (const idx of swapPositions) {
    for (const alt of letters[idx]!.alts!) {
      variants.push(letters.map((l, i) => (i === idx ? alt : l.p)).join(""));
    }
  }
  // короткие имена (≤4 значащих букв) — пара двойных свопов первых двух ambiguous-позиций
  const real = letters.filter((l) => l.p.trim()).length;
  if (real <= 4 && swapPositions.length >= 2) {
    const [a, b] = swapPositions;
    const altA = letters[a!]!.alts![0]!;
    const altB = letters[b!]!.alts![0]!;
    variants.push(letters.map((l, i) => (i === a ? altA : i === b ? altB : l.p)).join(""));
  }
  return dedupe(variants.map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean)).slice(0, MAX_VARIANTS);
}

/**
 * Свести ЛАТИНСКИЕ буквы строки к кириллице primary-рендерингом (диграфы сперва), кириллицу/цифры
 * оставить как есть. Для ЛЕКСИЧЕСКОГО матча STT-обрывков («в dot'е» → «в доте»): STT роняет доменные
 * слова в латиницу/микс, и токены перестают совпадать. Это RECALL-нормализация (обе стороны сводятся
 * одинаково перед сравнением), НЕ перевод и НЕ решение — решают пороги вызывающего (§13-принцип).
 */
export function latinToCyrillic(s: string): string {
  const str = String(s ?? "");
  if (!/[a-z]/i.test(str)) return str.toLowerCase();
  return tokenizeLat(str)
    .map((l) => l.p)
    .join("");
}

/**
 * Что ВПИСАТЬ в поиск, чтобы кросс-скриптовый контакт всплыл: оригинал + транслит-варианты.
 * Деуплик, кап. Это RECALL — модель потом решает, какой кандидат настоящий.
 */
export function nameSearchVariants(query: string, max = 5): string[] {
  const q = String(query ?? "").trim();
  if (!q) return [];
  return dedupe([q, ...transliterate(q)]).slice(0, Math.max(1, max));
}

// ── скоринг и решение ────────────────────────────────────────

/** Тип чата-кандидата. Канал/группа — НЕ получатель для «напиши человеку» (рандом-паблик ≠ контакт). */
export type CandidateKind = "user" | "group" | "channel" | "bot" | "unknown";

export interface Candidate {
  /** Имя чата как видно в Telegram (заголовок строки). */
  title: string;
  /** Превью последнего сообщения (для контекста модели, в матче НЕ участвует). */
  preview?: string;
  /** peerId Telegram: положительный → пользователь; отрицательный → группа/канал (конвенция TG). Стабильный ключ. */
  peerId?: string;
  /** Явный тип (если известен); иначе выводится из знака peerId. */
  kind?: CandidateKind;
  /** Это МОЙ существующий диалог (раздел «Chats»), а не глобальный паблик-поиск. Приоритет. */
  mine?: boolean;
}

export interface RankedCandidate extends Candidate {
  score: number;
  /** Совпадение в ОДНОМ алфавите (не через транслит-догадку) — основа для авто-отправки. */
  sameScript: boolean;
  kind: CandidateKind;
}

/** Тип кандидата: явный kind → иначе по знаку peerId (TG: −=группа/канал, +=пользователь) → unknown. */
export function classifyKind(c: Candidate): CandidateKind {
  if (c.kind) return c.kind;
  const p = String(c.peerId ?? "").trim();
  if (/^-/.test(p)) return "channel"; // отрицательный peerId — канал/супергруппа/чат (не личный человек)
  if (/^\d+$/.test(p)) return "user";
  return "unknown";
}

/** Человек-получатель (личный пользователь), а НЕ канал/группа. unknown трактуем как возможного человека. */
function isPerson(kind: CandidateKind): boolean {
  return kind === "user" || kind === "bot" || kind === "unknown";
}

export type PickAction = "send" | "ask" | "none";
export interface PickResult {
  action: PickAction;
  /** Точное имя выбранного чата (для action==='send'). */
  title?: string;
  /** Стабильный peerId выбранного — ключ опытной памяти + точное открытие (не зависит от имени). */
  peerId?: string;
  /** Кандидаты-ЛЮДИ по убыванию уверенности (каналы/паблики исключены) — их видит модель. */
  ranked: RankedCandidate[];
  /** Почему ask (§P1-тёзки, форензика 2026-07-14 «не та Катя»): "namesakes" = НЕСКОЛЬКО людей носят
   *  запрошенное имя («Катя» и «Катя Любимая») — по смыслу НЕ решить, спрашивать ВЛАДЕЛЬЦА;
   *  "unclear" = прочая неоднозначность (кросс-скрипт/слабые матчи) — может решить модель. */
  reason?: "namesakes" | "unclear";
}

/** Множество свёрнутых форм запроса: сам запрос + его транслит-варианты (для матча кандидатов). */
function queryForms(query: string): { folded: string; forms: Set<string> } {
  const folded = foldName(query);
  const forms = new Set<string>([folded]);
  for (const v of transliterate(query)) forms.add(foldName(v));
  return { folded, forms };
}

/**
 * НОСИТ ли кандидат запрошенное имя (для детекта ТЁЗОК, §P1 ревью р1). Шире, чем «однозначный
 * победитель»: имя-часть заголовка в ЛЮБОЙ позиции и в ЛЮБОМ алфавите. «Катя»/«Катя Любимая»/«Мама
 * Катя»/«Katya»/«Katya Beloved» — все НОСИТЕЛИ имени «катя». Если носителей ≥2 — по смыслу не решить,
 * спрашиваем владельца (namesakes), НЕ авто-шлём точному. Датив запроса («кате») сводится транслит-
 * формами queryForms к тем же кандидатам не всегда — поэтому меряем и по folded, и по формам.
 */
export function bearsName(query: string, title: string): boolean {
  const { folded, forms } = queryForms(query);
  const t = foldName(title);
  if (!t || !folded) return false;
  for (const f of new Set([folded, ...forms])) {
    if (!f || f.length < 2) continue;
    if (t === f) return true; // точное имя
    if (t.startsWith(`${f} `)) return true; // «Катя Любимая» (имя первым словом)
    if (t.endsWith(` ${f}`)) return true; // «Мама Катя» (имя последним словом)
    if (t.includes(` ${f} `)) return true; // «Мама Катя дома» (имя словом в середине)
  }
  return false;
}

/** Балл совпадения кандидата с запросом (0..100) + same-script-флаг. */
export function scoreCandidate(query: string, title: string): { score: number; sameScript: boolean } {
  const { folded, forms } = queryForms(query);
  const t = foldName(title);
  if (!t || !folded) return { score: 0, sameScript: false };
  const sameScript = scriptOf(folded) === scriptOf(t);

  // Один и тот же алфавит — самый надёжный сигнал.
  if (sameScript) {
    if (t === folded) return { score: 100, sameScript: true };
    if (t.startsWith(folded) || folded.startsWith(t)) return { score: 82, sameScript: true };
    if (t.includes(` ${folded}`) || t.includes(`${folded} `)) return { score: 60, sameScript: true };
    if (t.includes(folded)) return { score: 42, sameScript: true };
  }
  // Кросс-скрипт — через транслит-варианты (НЕ основание для авто-отправки сам по себе).
  let best = 0;
  for (const f of forms) {
    if (!f) continue;
    if (t === f) best = Math.max(best, 70);
    else if (t.startsWith(f) || f.startsWith(t)) best = Math.max(best, 55);
    else if (t.includes(` ${f}`) || t.includes(`${f} `)) best = Math.max(best, 40);
    else if (t.includes(f)) best = Math.max(best, 25);
  }
  return { score: best, sameScript: false };
}

/**
 * РЕШЕНИЕ о получателе. Авто-отправка ТОЛЬКО на однозначном сигнале; иначе — отдаём кандидатов
 * модели (она знает Герман=Herman, падежи, никнеймы). Никогда не «угадываем» при неоднозначности.
 *
 *  • ровно одно ТОЧНОЕ совпадение в одном алфавите → send (точное бьёт префиксы);
 *  • иначе ровно один уверенный (точное/префикс) в одном алфавите → send;
 *  • иначе ровно один правдоподобный КРОСС-скрипт кандидат (транслит точное/префикс) → send
 *    (Герман→единственный Herman); несколько кросс-кандидатов (Herman И German Petrov) → ask;
 *  • прочее с кандидатами → ask (решает модель); пусто → none.
 */
export function pickRecipient(query: string, candidates: readonly Candidate[]): PickResult {
  const ranked: RankedCandidate[] = candidates
    .map((c) => {
      const { score, sameScript } = scoreCandidate(query, c.title);
      return { ...c, score, sameScript, kind: classifyKind(c) };
    })
    .filter((c) => c.score > 0)
    // МОИ диалоги (mine) выше глобального паблик-поиска; затем по баллу.
    .sort((a, b) => Number(Boolean(b.mine)) - Number(Boolean(a.mine)) || b.score - a.score);

  // Получатель = ЧЕЛОВЕК (личный чат), НЕ канал/группа: «рандом-паблик ко мне не относится».
  const people = ranked.filter((c) => isPerson(c.kind));
  if (!people.length) return { action: "none", ranked: people };

  // Есть совпадения в МОИХ переписках → решаем СРЕДИ НИХ (глобальный паблик игнорируем как нерелевантный).
  const mine = people.filter((c) => c.mine);
  const pool = mine.length ? mine : people;
  const send = (c: RankedCandidate): PickResult => ({ action: "send", title: c.title, peerId: c.peerId, ranked: people });

  // §P1-ТЁЗКИ (форензика 2026-07-14, «напиши кате» ушло НЕ ТОЙ Кате; ревью р1: расширено на ВСЕ формы).
  // НОСИТЕЛИ запрошенного имени — кандидаты, чей заголовок содержит имя в любой позиции/алфавите
  // («Катя», «Катя Любимая», «Мама Катя», «Katya», «Katya Beloved»). ≥2 носителей → по смыслу не
  // решить, какую именно звал владелец → ask/namesakes (клиент даёт список с peerId, владелец выбирает,
  // модель повторяет с peer). Это ВЫШЕ exact-приоритета: точное «Катя» НЕ бьёт живую тёзку.
  const bearers = pool.filter((c) => bearsName(query, c.title));
  if (bearers.length >= 2) return { action: "ask", reason: "namesakes", ranked: people };

  const exactSame = pool.filter((c) => c.sameScript && c.score >= 100);
  const sureSame = pool.filter((c) => c.sameScript && c.score >= 82);

  // 1) Точное совпадение в одном алфавите (тёзок нет — bearers<2) → однозначно.
  if (exactSame.length === 1) return send(exactSame[0]!);
  if (exactSame.length > 1) return { action: "ask", reason: "namesakes", ranked: people };

  // 2) Один уверенный (точное/префикс) в одном алфавите.
  if (sureSame.length === 1) return send(sureSame[0]!);
  if (sureSame.length > 1) return { action: "ask", reason: "namesakes", ranked: people };

  // 3) Кросс-скрипт: РОВНО один правдоподобный транслит-кандидат (точное/префикс) → отправляем.
  const crossPlausible = pool.filter((c) => !c.sameScript && c.score >= 55);
  if (crossPlausible.length === 1) return send(crossPlausible[0]!);

  // 4) Неоднозначно (несколько кросс-кандидатов / только слабые подстроки) → решает модель.
  return { action: "ask", reason: "unclear", ranked: people };
}

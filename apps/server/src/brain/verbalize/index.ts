/**
 * Вербализация для TTS (§21) — детерминированный пост-процессор, НЕ LLM.
 *
 * Задача: превратить текстовый ответ в форму, пригодную для произнесения:
 *  - убрать markdown, URL, код-блоки, эмодзи;
 *  - числа → слова с согласованием рода/падежа (базовые случаи);
 *  - время «8:20» → «восемь двадцать»;
 *  - валюта «1500₽» → «полторы тысячи рублей» (рубли — общий алгоритм);
 *  - телефоны — посимвольно/по группам.
 *
 * Реализация расширяемая: словари вынесены и дополняемы. Алгоритм покрывает
 * базовые кейсы спеки; редкие падежи/род — best-effort, не претендует на
 * полноту морфологии.
 */

// ── публичный API ────────────────────────────────────────────

/** Полный конвейер вербализации. Порядок шагов важен (сначала чистим, потом числа). */
export function verbalize(input: string): string {
  let s = input;
  s = scrubIdentity(s); // ПЕРВЫМ: вырезать навязанную шлюзом identity «Kiro» (§11)
  s = stripCodeBlocks(s);
  s = stripMarkdown(s);
  s = stripUrls(s);
  s = stripEmoji(s);
  // Спец-сущности — до общего разбора чисел, чтобы «1500₽» не стало просто числом.
  s = verbalizePhones(s);
  s = verbalizeCurrency(s);
  s = verbalizeTime(s);
  s = verbalizeStandaloneNumbers(s);
  s = collapseWhitespace(s);
  return s;
}

// ── identity-скраб (§11) ─────────────────────────────────────

/** Имя ассистента. Шлюз (Kiro-обёртка) навязывает «Kiro» поверх системного промпта. */
const ASSISTANT_NAME = "Джарвис";

/**
 * Вырезать навязанную шлюзом identity «Kiro/Киро» и подменить на «Джарвис» (§11).
 * Детерминированный пост-процессор: работает независимо от того, что инъектирует
 * шлюз в системный промпт (он его игнорирует). Границы слова — через unicode-классы,
 * чтобы корректно ловить и латиницу, и кириллицу.
 */
export function scrubIdentity(s: string): string {
  let out = s;
  // Имя в любом регистре/алфавите → Джарвис. («Я Kiro» → «Я Джарвис», «меня зовут Киро» → …Джарвис.)
  out = out.replace(/(?<![\p{L}\p{N}])(?:kiro|киро|кiро|киро)(?![\p{L}\p{N}])/giu, ASSISTANT_NAME);
  // Снять самоописание «AI-ассистент для разработки/кодинга» — Джарвис не dev-ассистент.
  out = out.replace(
    /,?\s*(?:ai[\s-]*)?(?:ассистент|помощник)\s+(?:для|по)\s+(?:разработк\w*|программирован\w*|кодинг\w*|написани\w*\s+кода)(?:\s+(?:по|програм\w*|софта|п(?:рограммного\s+)?о(?:беспечения)?))?/giu,
    "",
  );
  out = out.replace(
    /,?\s*(?:an?\s+)?(?:ai\s+)?assistant\s+for\s+(?:software\s+)?(?:development|coding|engineering)/giu,
    "",
  );
  return out;
}

// ── очистка markdown / url / код ─────────────────────────────

/** Вырезать огороженные блоки кода ```...``` и инлайн `code`. */
export function stripCodeBlocks(s: string): string {
  return s
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]*)`/gu, "$1");
}

/** Снять markdown-разметку, оставив текст. */
export function stripMarkdown(s: string): string {
  return s
    // ссылки [текст](url) → текст
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/gu, "$1")
    // заголовки/цитаты в начале строки
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    // маркеры списков
    .replace(/^\s{0,3}[-*+]\s+/gmu, "")
    // жирный/курсив/зачёркнутый
    .replace(/(\*\*|__)(.*?)\1/gu, "$2")
    .replace(/(\*|_)(.*?)\1/gu, "$2")
    .replace(/~~(.*?)~~/gu, "$1")
    // горизонтальные линии
    .replace(/^\s*([-*_])\1{2,}\s*$/gmu, " ");
}

/** Удалить «голые» URL (markdown-ссылки уже сняты выше). */
export function stripUrls(s: string): string {
  return s
    .replace(/https?:\/\/\S+/giu, " ссылка ")
    .replace(/\bwww\.\S+/giu, " ссылка ");
}

/** Убрать эмодзи и большинство пиктографических символов. */
export function stripEmoji(s: string): string {
  // Диапазоны эмодзи + вариативные селекторы.
  return s.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,
    "",
  );
}

function collapseWhitespace(s: string): string {
  return s.replace(/[ \t]+/gu, " ").replace(/\s*\n\s*/gu, ". ").trim();
}

// ── телефоны ─────────────────────────────────────────────────

/**
 * Телефоны проговариваются по группам (без морфологии чисел).
 * Распознаём российский формат +7/8 (XXX) XXX-XX-XX и похожие.
 */
export function verbalizePhones(s: string): string {
  const phoneRe = /(?:\+7|8)[\s(]*\d{3}[\s)]*\d{3}[\s-]?\d{2}[\s-]?\d{2}/gu;
  return s.replace(phoneRe, (m) => {
    const digits = m.replace(/\D/gu, "");
    // 11 цифр: код страны + 3 + 3 + 2 + 2.
    const groups: string[] = [];
    if (digits.length === 11) {
      groups.push(digits[0] === "8" ? "восемь" : "плюс семь");
      groups.push(speakDigits(digits.slice(1, 4)));
      groups.push(speakDigits(digits.slice(4, 7)));
      groups.push(speakDigits(digits.slice(7, 9)));
      groups.push(speakDigits(digits.slice(9, 11)));
    } else {
      groups.push(speakDigits(digits));
    }
    return ` ${groups.join(" ")} `;
  });
}

/** Произнести строку цифр посимвольно: «495» → «четыре девять пять». */
function speakDigits(digits: string): string {
  return digits
    .split("")
    .map((d) => DIGIT_WORD[d] ?? d)
    .join(" ");
}

const DIGIT_WORD: Record<string, string> = {
  "0": "ноль",
  "1": "один",
  "2": "два",
  "3": "три",
  "4": "четыре",
  "5": "пять",
  "6": "шесть",
  "7": "семь",
  "8": "восемь",
  "9": "девять",
};

// ── валюта ───────────────────────────────────────────────────

/**
 * Валюта в рублях: «1500₽», «1500 руб», «1500 р.», «1 500 ₽».
 * Сумма → слова + согласованное «рубль/рубля/рублей».
 */
export function verbalizeCurrency(s: string): string {
  const rubRe =
    /(\d[\d\s.,]*\d|\d)\s*(?:₽|руб(?:\.|лей|ля|ль)?|р\.)/giu;
  return s.replace(rubRe, (_m, num: string) => {
    const value = parseNumber(num);
    if (value === null) return _m;
    return ` ${speakRubles(value)} `;
  });
}

/** Сумма рублей словами с согласованием (целые; копейки — упрощённо игнор/округление). */
export function speakRubles(value: number): string {
  const whole = Math.round(value);
  const colloquial = colloquialThousands(whole);
  const words = colloquial ?? numberToWords(whole, "masculine");
  return `${words} ${pluralRu(whole, ["рубль", "рубля", "рублей"])}`;
}

/**
 * Разговорные «полторы/две с половиной тысячи» для круглых/полукруглых сумм (§21).
 * Это естественнее для речи, чем «одна тысяча пятьсот». Покрываем частые случаи
 * X*1000 и X*1000+500 до 9500; иначе возвращаем null (общий алгоритм).
 */
function colloquialThousands(n: number): string | null {
  if (n < 1000 || n > 9500 || n % 500 !== 0) return null;
  const thousands = Math.trunc(n / 1000);
  const half = n % 1000 === 500;

  if (thousands === 1 && half) return "полторы тысячи"; // 1500
  if (half) {
    // 2500 → «две с половиной тысячи», 5500 → «пять с половиной тысяч».
    const t = numberToWords(thousands, "feminine");
    return `${t} с половиной ${pluralRu(thousands, ["тысячи", "тысячи", "тысяч"])}`;
  }
  // Ровные тысячи (1000/2000/...): обычный алгоритм уже хорош, но оставим единообразно.
  const t = numberToWords(thousands, "feminine");
  return `${t} ${pluralRu(thousands, ["тысяча", "тысячи", "тысяч"])}`;
}

// ── время ────────────────────────────────────────────────────

/**
 * Время «8:20» → «восемь двадцать», «09:05» → «девять ноль пять».
 * Минуты 0 → «ровно»: «8:00» → «восемь ровно».
 */
export function verbalizeTime(s: string): string {
  const timeRe = /\b([01]?\d|2[0-3]):([0-5]\d)\b/gu;
  return s.replace(timeRe, (_m, hh: string, mm: string) => {
    const h = Number.parseInt(hh, 10);
    const m = Number.parseInt(mm, 10);
    const hWord = numberToWords(h, "masculine");
    if (m === 0) return `${hWord} ровно`;
    if (m < 10) return `${hWord} ноль ${numberToWords(m, "feminine")}`;
    return `${hWord} ${numberToWords(m, "feminine")}`;
  });
}

// ── одиночные числа ──────────────────────────────────────────

/**
 * Оставшиеся самостоятельные числа → слова (мужской род по умолчанию).
 * Десятичные «3.5»/«3,5» → «три целых пять десятых» (базово).
 */
export function verbalizeStandaloneNumbers(s: string): string {
  // Десятичные.
  s = s.replace(/\b(\d+)[.,](\d+)\b/gu, (_m, int: string, frac: string) => {
    const i = Number.parseInt(int, 10);
    const f = Number.parseInt(frac, 10);
    const intWords = `${numberToWords(i, "feminine")} ${pluralRu(i, ["целая", "целых", "целых"])}`;
    const denom = DECIMAL_DENOM[frac.length] ?? "долей";
    const fracWords = `${numberToWords(f, "feminine")} ${denom}`;
    return `${intWords} ${fracWords}`;
  });
  // Целые.
  s = s.replace(/\b\d+\b/gu, (m) => {
    const n = Number.parseInt(m, 10);
    if (!Number.isFinite(n)) return m;
    return numberToWords(n, "masculine");
  });
  return s;
}

const DECIMAL_DENOM: Record<number, string> = {
  1: "десятых",
  2: "сотых",
  3: "тысячных",
};

// ── число → слова (RU) ───────────────────────────────────────

export type Gender = "masculine" | "feminine" | "neuter";

const UNITS_M = [
  "ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять",
  "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать",
  "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать",
];
const UNITS_F = [...UNITS_M];
UNITS_F[1] = "одна";
UNITS_F[2] = "две";

const TENS = [
  "", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят",
  "восемьдесят", "девяносто",
];
const HUNDREDS = [
  "", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот",
  "восемьсот", "девятьсот",
];

/** Разряды (тысячи/миллионы) с их родом и формами склонения. */
const SCALES: readonly { gender: Gender; forms: [string, string, string] }[] = [
  { gender: "masculine", forms: ["", "", ""] }, // единицы — род задаёт caller
  { gender: "feminine", forms: ["тысяча", "тысячи", "тысяч"] },
  { gender: "masculine", forms: ["миллион", "миллиона", "миллионов"] },
  { gender: "masculine", forms: ["миллиард", "миллиарда", "миллиардов"] },
];

/**
 * Натуральное число → слова. gender применяется к последней (единичной) группе:
 * для «1 рубль» — masculine, для «1 тысяча»/«1 целая» — feminine.
 */
export function numberToWords(value: number, gender: Gender = "masculine"): string {
  if (!Number.isFinite(value)) return String(value);
  const n = Math.trunc(value);
  if (n < 0) return `минус ${numberToWords(-n, gender)}`;
  if (n === 0) return "ноль";

  // Разбить на группы по 3 разряда (units, thousands, millions, ...).
  const groups: number[] = [];
  let rest = n;
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.trunc(rest / 1000);
  }

  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] ?? 0;
    if (g === 0) continue;
    const scale = SCALES[i] ?? SCALES[SCALES.length - 1]!;
    // Род группы: для разрядов — род разряда; для единиц — заданный gender.
    const groupGender: Gender = i === 0 ? gender : scale.gender;
    parts.push(threeDigitsToWords(g, groupGender));
    if (i > 0 && scale.forms[0] !== "") {
      parts.push(pluralRu(g, scale.forms));
    }
  }
  return parts.join(" ");
}

/** Группа 0..999 → слова с учётом рода единиц. */
function threeDigitsToWords(n: number, gender: Gender): string {
  const out: string[] = [];
  const h = Math.trunc(n / 100);
  const rem = n % 100;
  if (h > 0) out.push(HUNDREDS[h]!);

  if (rem < 20) {
    if (rem > 0) out.push(pickUnit(rem, gender));
  } else {
    const t = Math.trunc(rem / 10);
    const u = rem % 10;
    out.push(TENS[t]!);
    if (u > 0) out.push(pickUnit(u, gender));
  }
  return out.join(" ");
}

function pickUnit(n: number, gender: Gender): string {
  const table = gender === "feminine" ? UNITS_F : UNITS_M;
  return table[n] ?? String(n);
}

// ── согласование (плюрализация) ──────────────────────────────

/**
 * Выбрать форму по правилам русского числа: [одна, две-четыре, пять-много].
 * Напр. pluralRu(n, ["рубль","рубля","рублей"]).
 */
export function pluralRu(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

// ── парсинг числа из строки ──────────────────────────────────

/** «1 500,50» / «1500.5» / «1 500» → number | null. */
export function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/\s+/gu, "").replace(",", ".");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

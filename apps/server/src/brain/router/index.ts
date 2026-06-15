/**
 * Маршрутизация по тирам моделей (§7).
 *
 * Каскад (§7), от дешёвого к дорогому:
 *   tier0  — БЕЗ LLM. Детерминированные локальные паттерны (открой/запусти/фокус,
 *            открой сайт, простые управляющие фразы). Обрабатываются прямо в agent
 *            без обращения к модели → нулевая стоимость и минимальная латентность.
 *   haiku  — короткие реплики/болтовня/уточнения, не требующие рассуждения или
 *            инструментов. Дешёвая быстрая модель (§7).
 *   sonnet — многошаговые задачи, рассуждение, вызов инструментов, работа с памятью.
 *   fable  — самый сильный тир; здесь НЕ выбирается эвристикой (резерв под сложные
 *            планирующие задачи/эскалацию), чтобы не жечь бюджет случайно.
 *
 * M0/skeleton: классификатор детерминированный (regex + эвристики длины/ключевых слов).
 * Позже (§7) haiku-классификатор может уточнять пограничные случаи — за интерфейсом.
 */
import type { Tier } from "@jarvis/shared";

/** Результат классификации: тир + (для tier0) распознанный локальный интент. */
export interface RouteDecision {
  tier: Tier;
  /** Для tier0 — машинно-распознанный интент и его аргумент. */
  local?: LocalIntent;
  /** Человекочитаемая причина выбора (для логов/отладки §22). */
  reason: string;
}

/** Локальные интенты tier0 — обрабатываются без LLM (§7). */
export type LocalIntent =
  | { kind: "app.launch"; app: string }
  | { kind: "app.focus"; app: string }
  | { kind: "browser.open"; url: string };

/**
 * Паттерны запуска приложений: «открой <app>», «запусти <app>», «включи <app>».
 * Группа (?<app>...) — имя приложения/сайта.
 */
// Варианты глагола + допуск на STT-ослышки («открою» вместо «открой» и т.п.).
const LAUNCH_RE = /^\s*(?:открой|открои|открою|открыть|запусти|запущу|запустить|включи|включить)\s+(?<app>.+?)\s*[.!?]?\s*$/iu;

// Известные веб-сервисы: «открой инстаграм» = открыть сайт в браузере (НЕ приложение).
// Надёжно и без LLM (детерминированно). Ключи — нормализованные (lowercase) имена.
const WEB_SERVICES: Record<string, string> = {
  инстаграм: "https://instagram.com",
  инстаграмм: "https://instagram.com",
  инста: "https://instagram.com",
  instagram: "https://instagram.com",
  ютуб: "https://youtube.com",
  ютьюб: "https://youtube.com",
  ютюб: "https://youtube.com",
  youtube: "https://youtube.com",
  вконтакте: "https://vk.com",
  вк: "https://vk.com",
  vk: "https://vk.com",
  телеграм: "https://web.telegram.org",
  телеграмм: "https://web.telegram.org",
  telegram: "https://web.telegram.org",
  фейсбук: "https://facebook.com",
  facebook: "https://facebook.com",
  твиттер: "https://twitter.com",
  twitter: "https://twitter.com",
  икс: "https://x.com",
  гугл: "https://google.com",
  google: "https://google.com",
  гмейл: "https://mail.google.com",
  почта: "https://mail.google.com",
  gmail: "https://mail.google.com",
  чатгпт: "https://chatgpt.com",
  chatgpt: "https://chatgpt.com",
  тикток: "https://tiktok.com",
  tiktok: "https://tiktok.com",
};
/** Паттерны фокуса: «переключись на <app>», «перейди в <app>». */
const FOCUS_RE = /^\s*(?:переключись на|перейди в|перейди к|фокус на)\s+(?<app>.+?)\s*[.!?]?\s*$/iu;

/** Слова, после которых «открой» означает сайт/URL, а не приложение. */
const SITE_HINT_RE = /^(?:сайт|страниц[уы]|ссылк[уи])\s+/iu;
/** Грубое распознавание URL/домена. */
const URL_RE = /^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/iu;

/**
 * Главный классификатор тира (§7). Чистая функция от текста реплики.
 */
export function classifyTier(text: string): RouteDecision {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { tier: "haiku", reason: "пустой/пробельный ввод" };
  }

  // 1) tier0 — локальные детерминированные паттерны.
  const local = matchLocalIntent(trimmed);
  if (local) {
    return { tier: "tier0", local, reason: `локальный интент ${local.kind}` };
  }

  // 2) Эвристика haiku vs sonnet.
  if (looksComplex(trimmed)) {
    return { tier: "sonnet", reason: "многошаговая/рассуждающая задача" };
  }
  return { tier: "haiku", reason: "короткая реплика/болтовня" };
}

/**
 * Распознать локальный интент tier0. Экспортируется отдельно: agent (§M0)
 * использует это, чтобы превратить интент в ActionCommand.
 */
export function matchLocalIntent(text: string): LocalIntent | undefined {
  // КЛЮЧЕВОЕ: STT включает слово-будильник и вежливость в транскрипт
  // («Джарвис, привет! Запусти Инстаграм») — срезаем их, иначе LAUNCH_RE (привязан к
  // началу) не сработает и команда уйдёт в LLM, которая «врёт, что открыла».
  const cleaned = stripWakeAndFiller(text);

  const launch = LAUNCH_RE.exec(cleaned);
  if (launch?.groups?.app) {
    let arg = stripTrailingFiller(stripQuotes(launch.groups.app.trim()));

    // «открой сайт x» / «открой ссылку x» → browser.open.
    if (SITE_HINT_RE.test(arg)) {
      return { kind: "browser.open", url: normalizeUrl(arg.replace(SITE_HINT_RE, "").trim()) };
    }
    // «открой example.com» → browser.open (URL целиком или первым словом).
    const first = arg.split(/\s+/u)[0] ?? "";
    if (URL_RE.test(arg)) return { kind: "browser.open", url: normalizeUrl(arg) };
    if (URL_RE.test(first)) return { kind: "browser.open", url: normalizeUrl(first) };
    // Известный веб-сервис ГДЕ-УГОДНО во фразе («инстаграм в браузере», «открой ютуб
    // пожалуйста») → сайт в браузере. Сканируем токены, не требуем точного совпадения.
    const site = findWebService(arg);
    if (site) return { kind: "browser.open", url: site };
    // Имя приложения — короткое (≤3 слов) и без вопросительных слов («открой мне почему
    // так дорого» → не приложение, уходит в LLM).
    const app = normalizeAppName(arg);
    if (app.length > 0 && looksLikeAppName(app)) return { kind: "app.launch", app };
  }

  const focus = FOCUS_RE.exec(cleaned);
  if (focus?.groups?.app) {
    const app = normalizeAppName(stripTrailingFiller(stripQuotes(focus.groups.app.trim())));
    if (app.length > 0 && looksLikeAppName(app)) return { kind: "app.focus", app };
  }

  return undefined;
}

/** Слова-будильники (+ частые ослышки Whisper) и ведущая вежливость — срезаем с начала. */
const LEAD_STRIP_RE =
  /^[\s,!.:;-]*(?:джарвис[ауе]?|джарвиз|джарис|жарвис|сервис|эй|привет|пожалуйста|слушай(?:-ка)?|будь добр|давай|ну|короче|так|слышишь)[\s,!.:;-]*/iu;

function stripWakeAndFiller(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 6; i += 1) {
    const next = t.replace(LEAD_STRIP_RE, "");
    if (next === t) break;
    t = next;
  }
  return t.trim();
}

/** Хвостовая вежливость/уточнения и пунктуация — «инстаграм, ты это умеешь» → «инстаграм». */
const TRAIL_STRIP_RE =
  /[\s,.!?]*(?:в\s+браузере|в\s+браузер|браузере|пожалуйста|сейчас|давай|быстро|по-быстрому|ты\s+это\s+умеешь|умеешь|будь\s+добр|если\s+можешь|уже)\s*$/iu;

function stripTrailingFiller(arg: string): string {
  let a = arg.trim();
  for (let i = 0; i < 5; i += 1) {
    const next = a.replace(TRAIL_STRIP_RE, "").trim();
    if (next === a) break;
    a = next;
  }
  return a.replace(/[\s,.!?]+$/u, "").trim();
}

/** Найти известный веб-сервис среди токенов фразы (а не точным совпадением всей строки). */
function findWebService(arg: string): string | undefined {
  const norm = normalizeAppName(arg);
  if (WEB_SERVICES[norm]) return WEB_SERVICES[norm];
  for (const tok of norm.split(/\s+/u)) {
    if (WEB_SERVICES[tok]) return WEB_SERVICES[tok];
  }
  // Опечатка/ослышка STT («ютюп»→ютуб, «тельаграм»→телеграм) — fuzzy по словарю сервисов.
  return fuzzyWebService(norm);
}

/**
 * Fuzzy-поиск веб-сервиса среди токенов: ближайший ключ словаря по расстоянию Левенштейна
 * в пределах порога (короткие слова — строже, чтобы «вк»/«икс» не путались). Закрытый
 * словарь → ложных срабатываний почти нет; нераспознанное уходит в LLM, как и раньше.
 */
function fuzzyWebService(norm: string): string | undefined {
  const keys = Object.keys(WEB_SERVICES);
  let best: { url: string; dist: number } | undefined;
  for (const tok of norm.split(/\s+/u)) {
    if (tok.length < 5) continue; // короткие слова — слишком много ложных совпадений
    // СТРОГО: расстояние ≤1 (одна опечатка/ослышка). Иначе обычные слова ловятся как
    // сервисы («тикетов»→tiktok). + общий префикс ≥3 символа (название узнаётся с начала).
    const thr = 1;
    for (const key of keys) {
      if (Math.abs(key.length - tok.length) > thr) continue;
      if (key.slice(0, 3) !== tok.slice(0, 3)) continue; // одинаковое начало
      const d = levenshtein(tok, key);
      if (d <= thr && (!best || d < best.dist)) best = { url: WEB_SERVICES[key]!, dist: d };
    }
  }
  return best?.url;
}

/** Расстояние Левенштейна (две строки, O(n) память) — для fuzzy-матчинга названий. */
function levenshtein(a: string, b: string): number {
  const n = b.length;
  if (a.length === 0) return n;
  if (n === 0) return a.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

/** Вопросительные/служебные слова: их присутствие = это не имя приложения, а фраза. */
const NON_APP_WORDS_RE = /(?<![\p{L}\p{N}])(?:почему|зачем|как|что|чё|чо|где|когда|кто|какой|какая|какие|ли|мне|нам)(?![\p{L}\p{N}])/iu;

/** Похоже ли на имя приложения: ≤3 слов и без вопросительных слов. */
function looksLikeAppName(arg: string): boolean {
  const words = arg.split(/\s+/u).filter(Boolean);
  if (words.length > 3) return false;
  if (NON_APP_WORDS_RE.test(arg)) return false;
  return true;
}

// ── эвристики сложности ──────────────────────────────────────

// ВАЖНО: \b в JS-regex работает только с ASCII (\w = [A-Za-z0-9_]); для кириллицы
// \bслово\b не срабатывает. Поэтому границы слова — через Unicode-property lookbehind/lookahead.
const LB = "(?<![\\p{L}\\p{N}])"; // левая граница слова (учитывает кириллицу)
const RB = "(?![\\p{L}\\p{N}])"; //  правая граница слова
const word = (alt: string): RegExp => new RegExp(`${LB}(?:${alt})${RB}`, "iu");

/** Маркеры многошаговости/рассуждения → sonnet (§7). */
const COMPLEX_MARKERS: readonly RegExp[] = [
  word("и затем|потом|после этого"),
  word("найди|поищи|сравни|проанализируй|составь|напиши"),
  word("почему|объясни|как (?:мне|лучше)"),
  word("закаж[иь]|отправ[ьи]|заброниру[йе]"), // действия с подтверждением → планирование
  // Задачи-действия на компьютере (файлы/документы/настройка) → многошагово → фон (§20).
  word("созда[йть]|запиши|сохрани|удали|настрой|собери|заполни|переименуй|перемести|скачай"),
];

function looksComplex(text: string): boolean {
  if (text.length > 140) return true; // длинная формулировка ≈ составная задача
  return COMPLEX_MARKERS.some((re) => re.test(text));
}

// ── нормализация аргументов ──────────────────────────────────

function stripQuotes(s: string): string {
  return s.replace(/^["«»'`]+|["«»'`]+$/gu, "").trim();
}

/** Привести имя приложения к канону (lowercase, схлопнуть пробелы). */
function normalizeAppName(s: string): string {
  return s.toLowerCase().replace(/\s+/gu, " ").trim();
}

/** Достроить схему URL, если опущена. */
function normalizeUrl(s: string): string {
  const u = s.trim();
  if (/^https?:\/\//iu.test(u)) return u;
  return `https://${u}`;
}

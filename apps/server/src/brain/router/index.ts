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
const LAUNCH_RE = /^\s*(?:открой|открыть|запусти|запустить|включи|включить)\s+(?<app>.+?)\s*[.!?]?\s*$/iu;
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
  const launch = LAUNCH_RE.exec(text);
  if (launch?.groups?.app) {
    let arg = stripQuotes(launch.groups.app.trim());

    // «открой сайт x» / «открой ссылку x» → browser.open.
    if (SITE_HINT_RE.test(arg)) {
      const url = arg.replace(SITE_HINT_RE, "").trim();
      return { kind: "browser.open", url: normalizeUrl(url) };
    }
    // «открой example.com» → browser.open; иначе — app.launch.
    if (URL_RE.test(arg)) {
      return { kind: "browser.open", url: normalizeUrl(arg) };
    }
    arg = normalizeAppName(arg);
    if (arg.length > 0) return { kind: "app.launch", app: arg };
  }

  const focus = FOCUS_RE.exec(text);
  if (focus?.groups?.app) {
    const app = normalizeAppName(stripQuotes(focus.groups.app.trim()));
    if (app.length > 0) return { kind: "app.focus", app };
  }

  return undefined;
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

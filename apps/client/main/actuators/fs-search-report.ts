/**
 * Отчёт о ПОЛНОТЕ обхода `fs.search` (§6; CAPABILITY_GAPS 2026-09-01 §3.3).
 *
 * Факт: на рабочем столе владельца 588 213 файлов, кап 20 000 просмотренных покрывает 3,4% дерева, и
 * `{matches:[], truncated:true}` модель читала как «не нашёл», хотя правда — «не досмотрел 96%». Раньше
 * `truncated` ставился и на «упёрлись в maxResults», и на «упёрлись в кап просмотренных» — неразличимо,
 * а нечитаемый каталог (`catch{return}`) не оставлял следа вовсе.
 *
 * Ревью 2026-09-01: «дерево пройдено ДО КОНЦА» обязано учитывать ВСЕ пропуски, а не только каталоги —
 * ссылки/junction (по ним не ходим), нечитаемые и слишком большие файлы, файлы не в UTF-8 (кириллическую
 * иголку в cp1251 так не найти) — иначе exhausted:true превращало «не смог» в «нет». Плюс бюджет ВРЕМЕНИ:
 * inContent на реальном дереве шёл 129 с при таймауте действия 15 с — модель получала error.timeout без
 * отчёта о полноте, а обход продолжал жечь диск в фоне.
 */
import { promises as fsp } from "node:fs";
import { envInt } from "@jarvis/shared";

export type SearchStopReason = "max_results" | "scan_cap" | "time_budget";
export interface SearchMatch {
  path: string;
  line?: number;
  preview?: string;
  /** Каталог, совпавший по имени («где папка jarvis?») — раньше папки не матчились вовсе. */
  kind?: "dir";
}
/** Всё, что обход ПРОПУСТИЛ, — каждый счётчик делает exhausted=false и получает строку в note. */
export interface SearchGaps {
  /** Каталоги, которые не удалось прочитать (нет прав/недоступны). */
  skippedDirs: number;
  /** Ссылки/junction — по ним не ходим (петли; алиас на секретный каталог), их содержимое не досмотрено. */
  skippedLinks: number;
  /** Файлы, которые не удалось прочитать (заняты/нет прав) — только при inContent. */
  unreadableFiles: number;
  /** Файлы больше лимита чтения — по содержимому не сканировались (inContent). */
  oversizedFiles: number;
  /** Файлы не в UTF-8 (в декодированном тексте «�») — кириллицу в них так не найти (inContent). */
  undecodedFiles: number;
}
export interface SearchResult extends SearchGaps {
  matches: SearchMatch[];
  /**
   * Каталоги, пропущенные НАМЕРЕННО по списку ignore (деф. служебные: node_modules/.git/dist…). Это НЕ пропуск
   * в смысле exhausted (мы их и не собирались смотреть), но модель обязана видеть, что там не искали.
   */
  ignoredDirs: number;
  /** Какие имена реально пропускались (уникальные, кап 12) — чтобы модель могла назвать их владельцу или снять ignore. */
  ignoredNames: string[];
  /** Совместимость: результат НЕПОЛНЫЙ из-за капа (эквивалент `stopReason !== undefined`). */
  truncated: boolean;
  /** Какой кап остановил обход. Нет — обход не останавливали. */
  stopReason?: SearchStopReason;
  /** Сколько файлов реально просмотрено (по имени или содержимому). */
  scannedFiles: number;
  /** Файлы не в UTF-8, прочитанные как cp1251 ПО ЭВРИСТИКЕ (inContent) — искали, но koi8-r/cp866 так не распознать. Не пропуск. */
  recodedFiles: number;
  /** true ТОЛЬКО если дерево пройдено ДО КОНЦА: ни одного капа и ни одного пропуска (см. SearchGaps). */
  exhausted: boolean;
  /** Честная пометка для модели (по-русски), есть только когда результат неполный. */
  note?: string;
}
export interface SearchOptions {
  /**
   * Имена каталогов, которые НЕ обходить (без учёта регистра). undefined → DEFAULT_IGNORED_DIRS; [] → обходить всё.
   * Корень поиска не игнорируется никогда (владелец назвал его явно).
   */
  ignore?: readonly string[];
  /** Переопределить кап просмотренных файлов (тесты/особые вызовы); дефолт — env или 20000. */
  scanCap?: number;
  /** Переопределить бюджет времени обхода, мс (тесты); дефолт — env или 40 000. */
  budgetMs?: number;
}

export const EMPTY_GAPS: Readonly<SearchGaps> = { skippedDirs: 0, skippedLinks: 0, unreadableFiles: 0, oversizedFiles: 0, undecodedFiles: 0 };

/**
 * Служебные каталоги, которые обход НЕ заходит по умолчанию (причина №6 USER_SCENARIOS_2026-09-02): node_modules
 * репозитория — сотни тысяч файлов, кап 20 000 съедался ими целиком, и «не найдено» относилось к чужим пакетам, а
 * не к коду владельца. Только заведомо генерируемое/чужое; «bin»/«src»/«lib» сюда НЕ входят — слишком общие имена.
 */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  "node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", "coverage",
  "target", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".gradle", ".idea", ".vs", ".pnpm-store",
];

/**
 * Кап ПРОСМОТРЕННЫХ файлов за один search. Настраивается env `JARVIS_FS_SEARCH_SCAN_CAP`, читается
 * ЛЕНИВО на вызове (не на module-load — `.env` грузится после ESM-хойста импортов, грабля device эмбеддера).
 */
export const DEFAULT_SEARCH_SCAN_CAP = 20000;
/** Бюджет времени обхода — СТРОГО ниже серверного таймаута действия fs.search (60 с, protocol/constants). */
export const DEFAULT_SEARCH_BUDGET_MS = 40_000;

export function searchScanCap(opts?: SearchOptions): number {
  const n = opts?.scanCap ?? envInt("JARVIS_FS_SEARCH_SCAN_CAP", DEFAULT_SEARCH_SCAN_CAP);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_SEARCH_SCAN_CAP;
}

/** Бюджет времени: явный opts (тесты могут дать 0), иначе env с полом 1 с (0 в env — кривая настройка, не «без поиска»). */
export function searchBudgetMs(opts?: SearchOptions): number {
  if (opts?.budgetMs !== undefined && Number.isFinite(opts.budgetMs) && opts.budgetMs >= 0) return opts.budgetMs;
  const n = envInt("JARVIS_FS_SEARCH_BUDGET_MS", DEFAULT_SEARCH_BUDGET_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DEFAULT_SEARCH_BUDGET_MS;
}

export function isExhausted(stop: SearchStopReason | undefined, g: SearchGaps): boolean {
  return stop === undefined && g.skippedDirs === 0 && g.skippedLinks === 0 && g.unreadableFiles === 0 && g.oversizedFiles === 0 && g.undecodedFiles === 0;
}

/**
 * Пометка о неполноте — попадает в tool_result как есть. Формулировки честные: при maxResults мы НЕ
 * знаем, есть ли ещё совпадения (обход остановлен), поэтому «может быть больше», а не «больше».
 */
export function searchNote(
  stop: SearchStopReason | undefined,
  ctx: {
    scanCap: number;
    limit: number;
    budgetMs: number;
    scanned: number;
    recodedFiles?: number;
    ignoredDirs?: number;
    ignoredNames?: readonly string[];
    /** Сколько РАЗНЫХ имён пропускалось (список выше капнут). */
    ignoredDistinct?: number;
    /** Список ignore задал вызывающий (не служебные по умолчанию) — формулировка без «служебных». */
    customIgnore?: boolean;
  } & SearchGaps,
): string | undefined {
  const parts: string[] = [];
  if (stop === "scan_cap") {
    parts.push(
      `⚠️ Дерево НЕ досмотрено: обход остановлен по капу ${ctx.scanCap} просмотренных файлов; «не найдено» здесь значит «не досмотрел». Сузь root ИЛИ используй поиск по индексу Windows (app_channels: «найди файл»).`,
    );
  }
  if (stop === "time_budget") {
    parts.push(
      `⚠️ Дерево НЕ досмотрено: обход остановлен по бюджету времени ${Math.round(ctx.budgetMs / 1000)} с (просмотрено ${ctx.scanned} файлов); «не найдено» здесь значит «не досмотрел». Сузь root ИЛИ используй поиск по индексу Windows (app_channels: «найди файл»).`,
    );
  }
  if (stop === "max_results") {
    parts.push(`достигнут maxResults=${ctx.limit} — показаны первые ${ctx.limit} совпадений, остаток дерева не досмотрен (совпадений может быть больше).`);
  }
  if (ctx.skippedDirs > 0) parts.push(`${ctx.skippedDirs} ${plural(ctx.skippedDirs, "каталог", "каталога", "каталогов")} не удалось прочитать (нет прав/недоступны) — их содержимое не досмотрено.`);
  if (ctx.skippedLinks > 0) parts.push(`${ctx.skippedLinks} ${plural(ctx.skippedLinks, "ссылка/junction", "ссылки/junction", "ссылок/junction")} не пройдено (по ссылкам не ходим) — их содержимое не досмотрено.`);
  if (ctx.unreadableFiles > 0) parts.push(`${ctx.unreadableFiles} ${plural(ctx.unreadableFiles, "файл", "файла", "файлов")} не удалось прочитать (заняты/нет прав) — их содержимое не досмотрено.`);
  if (ctx.oversizedFiles > 0) parts.push(`${ctx.oversizedFiles} ${plural(ctx.oversizedFiles, "файл", "файла", "файлов")} больше 2 МБ — по содержимому не сканировались.`);
  if (ctx.undecodedFiles > 0) parts.push(`${ctx.undecodedFiles} ${plural(ctx.undecodedFiles, "файл", "файла", "файлов")} не в UTF-8 и не похожи на cp1251 — кириллицу в них так не найти; ищи через code_run с явной кодировкой.`);
  if ((ctx.ignoredDirs ?? 0) > 0) {
    const shown = (ctx.ignoredNames ?? []).slice(0, 6);
    const distinct = ctx.ignoredDistinct ?? (ctx.ignoredNames ?? []).length;
    const names = shown.join(", ") + (distinct > shown.length ? ` и ещё ${distinct - shown.length}` : "");
    const what = ctx.customIgnore ? "по списку ignore" : "служебных (по умолчанию)";
    parts.push(
      `${ctx.ignoredDirs} ${plural(ctx.ignoredDirs!, "каталог", "каталога", "каталогов")} пропущено намеренно, ${what}: ${names || "—"} — там не искали; нужно и там — повтори с ignore:[] (или своим списком).`,
    );
  }
  if ((ctx.recodedFiles ?? 0) > 0) parts.push(`${ctx.recodedFiles} ${plural(ctx.recodedFiles!, "файл", "файла", "файлов")} не в UTF-8 — прочитаны как cp1251 по эвристике (koi8-r/cp866 так не распознаются).`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/**
 * Почему не читается КОРЕНЬ поиска — по коду ошибки ОС (корень недоступен = ошибка, а не «файлов нет»).
 * ⚠️ Windows: `readdir` по ФАЙЛУ даёт ENOENT, а не ENOTDIR (проверено живьём) — сверяем stat'ом, иначе
 * соврали бы «не существует» про существующий файл.
 */
export async function describeDirError(dir: string, e: unknown): Promise<string> {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    const st = await fsp.stat(dir).catch(() => null);
    if (st === null) return "не существует";
    return st.isDirectory() ? `недоступен (${code})` : "не каталог (это файл)";
  }
  if (code === "EACCES" || code === "EPERM") return "недоступен (нет прав)";
  return `недоступен (${code ?? (e instanceof Error ? e.message : String(e))})`;
}

/**
 * САМОПОЗНАНИЕ: «где мой код и что в нём» (волна I, 2026-08-31 — запрос владельца «хочу, чтобы он
 * сам понимал свой код и свои слабости и себя редактировал»).
 *
 * До этого Джарвис умел читать ЛЮБЫЕ файлы (fs_read через клиента), но НЕ ЗНАЛ, какие из них —
 * он сам: путь к репозиторию нигде не был выражен, поэтому «посмотри свой код» превращалось в
 * угадывание каталогов на диске владельца. Здесь это знание становится явным и безопасным.
 *
 * Границы (важнее удобства):
 *  • читаем ТОЛЬКО внутри своего репозитория — наружу этот канал не смотрит вовсе;
 *  • `data/` (профиль, память, чекпойнты, логи) — НЕ код: там личные данные владельца, и «изучение
 *    себя» не повод их листать; для них есть отдельные, гейтнутые пути (вкладка «Память», /cogs);
 *  • `.env`, ключи, `node_modules`, `.git`, сборки — вне выдачи всегда.
 * Читающий модуль: ничего не пишет. Правку своего кода делает patch.ts под рельсами и подтверждением.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, realpathSync, type Dirent } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Маркер корня монорепозитория: он лежит рядом с apps/ и packages/. */
const ROOT_MARKER = "pnpm-workspace.yaml";

/** Что НИКОГДА не отдаём как «свой код» (секреты, данные владельца, мусор сборки). */
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "data", ".vite", "coverage", ".turbo"]);
/** Расширения, которые считаем кодом/документацией о себе. */
const CODE_EXT = /\.(ts|tsx|mjs|cjs|js|jsx|md|json|sql|ps1|cs)$/i;
/** Файлы-секреты: даже внутри репозитория читать их «как свой код» нельзя. */
const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|.*\.key|.*\.pem|id_rsa.*|credentials-master\.key)$/i;

const MAX_FILE_BYTES = 400_000;
/** Потолок обхода: репозиторий большой, а на один вопрос модели нужен ответ, а не полный индекс. */
const MAX_SCANNED_FILES = 4000;

let cachedRoot: string | undefined;

/**
 * Корень собственного репозитория. Ищем вверх от этого модуля — так путь верен и в dev (tsx из
 * apps/server), и при установке в другое место: жёсткая строка в конфиге разъехалась бы молча.
 */
export function selfRepoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, ROOT_MARKER))) {
      cachedRoot = dir;
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // Маркер не найден (нестандартная установка) — честно отдаём каталог сервера, а не выдумываем корень.
  cachedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return cachedRoot;
}

/** Только для тестов: сбросить кеш корня. */
export function _resetSelfRepoRootForTest(): void {
  cachedRoot = undefined;
}

/**
 * Только для тестов: указать корень явно. Нужен ПОВЕДЕНЧЕСКИМ тестам самоправки — они гоняют
 * реальный git-цикл во временном репозитории, а не проверяют текст исходника на наличие слов
 * (аудит тестов 2026-09-01 показал, что grep-проверки гардов не ловят их обезвреживание).
 */
export function _setSelfRepoRootForTest(dir: string): void {
  cachedRoot = dir;
}

/**
 * Путь внутри репозитория и не в исключённой зоне? БЕЗ обращения к диску — используется в горячем
 * обходе каталогов, где записи `readdir` уже канонические (урок контроль-4 волны E: `realpath` на
 * каждую запись обхода морозит процесс на сотнях тысяч сисколлов).
 *
 * 🔴 Сравнение имён — БЕЗ учёта регистра: на Windows `Data/profile.json` и `data/profile.json` —
 * ОДИН файл, поэтому регистрозависимая проверка была бы обходом денилиста в один символ.
 */
export function isOwnCodePath(absPath: string, root = selfRepoRoot()): boolean {
  const rel = relative(root, absPath);
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== resolve(absPath)) return false;
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => EXCLUDED_DIRS.has(p.toLowerCase()))) return false;
  if (SECRET_FILE.test(absPath)) return false;
  return true;
}

/**
 * Канонизация пути: разворачивает symlink/junction, короткие имена Windows (8.3) и регистр.
 * Нужна ТОЛЬКО на верхнем уровне (путь, пришедший от модели) — там, где злоумышленник может
 * подсунуть ссылку, ведущую наружу репозитория или в личные данные владельца. Путь не существует
 * (создание нового файла) → возвращаем как есть: у несуществующей цели нет и цели ссылки.
 */
function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Разрешить относительный путь в абсолютный внутри репозитория (или undefined, если он вне границ).
 * Проверяем ДВАЖДЫ: по написанному пути и по каноническому — иначе junction внутри репозитория,
 * указывающий на `~/.ssh` или на `data/`, прошёл бы как «свой код» (класс, который проект уже
 * закрывал в self-guard клиента; здесь он был бы дырой в новом канале чтения).
 */
export function resolveOwnPath(relPath: string, root = selfRepoRoot()): string | undefined {
  const abs = resolve(root, String(relPath ?? "").trim());
  if (!isOwnCodePath(abs, root)) return undefined;
  const canon = canonical(abs);
  if (canon !== abs && !isOwnCodePath(canon, canonical(root))) return undefined;
  return abs;
}

export interface OwnFile {
  path: string;
  /** Строки файла с 1-based нумерацией — модель адресует правку номером строки. */
  lines: string[];
  totalLines: number;
  truncated: boolean;
}

/** Прочитать собственный файл (кап по размеру и числу строк — читаем окно, а не весь мир). */
export async function readOwnFile(relPath: string, opts: { from?: number; limit?: number } = {}): Promise<OwnFile> {
  const abs = resolveOwnPath(relPath);
  if (!abs) throw new Error(`Путь вне моего кода (или закрыт): ${relPath}`);
  const st = await stat(abs);
  if (st.size > MAX_FILE_BYTES) throw new Error(`Файл слишком велик (${Math.round(st.size / 1024)} КБ) — читай кусками через from/limit`);
  const all = (await readFile(abs, "utf8")).split(/\r?\n/);
  const from = Math.max(1, Number(opts.from) || 1);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 400, 2000));
  const slice = all.slice(from - 1, from - 1 + limit);
  return { path: relative(selfRepoRoot(), abs).split(sep).join("/"), lines: slice, totalLines: all.length, truncated: from - 1 + slice.length < all.length };
}

export interface CodeHit {
  path: string;
  line: number;
  text: string;
}

/** Длиннее — не паттерн, а полотно: такие выражения и медленны, и бессмысленны для поиска по коду. */
const MAX_PATTERN_CHARS = 200;
/** Строку длиннее этого не матчим целиком: минифицированные и base64-строки — топливо для бэктрекинга. */
const MAX_LINE_CHARS = 2000;
/** Общий бюджет поиска: обход синхронно держит event loop, а на нём живёт голос владельца. */
const SEARCH_BUDGET_MS = 5000;

/**
 * Признак КАТАСТРОФИЧЕСКОГО бэктрекинга: квантификатор, навешенный на группу, внутри которой тоже
 * есть квантификатор («(a+)+», «(\s*\w*)*»). Эвристика намеренно грубая — она не обязана распознать
 * все опасные выражения, её задача — не пустить самые дешёвые способы подвесить процесс.
 */
export function looksCatastrophic(pattern: string): boolean {
  return /\([^)]*[+*}][^)]*\)\s*[+*]/.test(pattern) || /(\[[^\]]*\][+*]){2,}/.test(pattern);
}

/**
 * Компиляция поискового выражения. 🔴 Паттерн приходит ОТ МОДЕЛИ (а через прочитанную страницу — и от
 * атакующего), поэтому произвольная регулярка здесь — способ повесить весь сервер: обход синхронный,
 * event loop один, на нём же голос и все сессии (ровно тот класс, что закрывали в web.ts).
 * Опасное или слишком длинное выражение ищем КАК ТЕКСТ — поиск остаётся рабочим, но безопасным.
 */
export function compileSearch(pattern: string): RegExp {
  const literal = (p: string): RegExp => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const raw = String(pattern ?? "");
  if (raw.length > MAX_PATTERN_CHARS || looksCatastrophic(raw)) return literal(raw.slice(0, MAX_PATTERN_CHARS));
  try {
    return new RegExp(raw, "i");
  } catch {
    return literal(raw); // невалидная регулярка → ищем как текст
  }
}

/**
 * Поиск по собственному коду (регулярка или подстрока). Своя реализация вместо внешнего grep:
 * инструмент должен работать одинаково на машине владельца и в тестах, без предположений о PATH.
 */
export async function searchOwnCode(
  pattern: string,
  opts: { dir?: string; maxHits?: number; ext?: RegExp } = {},
): Promise<{ hits: CodeHit[]; scannedFiles: number; capped: boolean }> {
  const root = selfRepoRoot();
  const start = opts.dir ? resolveOwnPath(opts.dir) : root;
  if (!start) throw new Error(`Каталог вне моего кода: ${opts.dir}`);
  const re = compileSearch(pattern);
  const maxHits = Math.max(1, Math.min(Number(opts.maxHits) || 60, 300));
  const ext = opts.ext ?? CODE_EXT;
  const hits: CodeHit[] = [];
  let scannedFiles = 0;
  let capped = false;
  const deadline = Date.now() + SEARCH_BUDGET_MS;

  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= maxHits || scannedFiles >= MAX_SCANNED_FILES || Date.now() > deadline) return;
    let entries: Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // недоступный каталог не должен рушить весь поиск
    }
    for (const e of entries) {
      if (hits.length >= maxHits || scannedFiles >= MAX_SCANNED_FILES || Date.now() > deadline) {
        capped = true;
        return;
      }
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        // Регистр — как в isOwnCodePath: «Data» и «data» на Windows один каталог.
        if (EXCLUDED_DIRS.has(e.name.toLowerCase())) continue;
        // Ссылка (symlink/junction) может увести обход ВНЕ репозитория или в личные данные, и она же
        // способна замкнуть обход в цикл. Настоящий каталог наружу увести не может, поэтому дорогой
        // канонизации здесь не нужно — достаточно НЕ ходить по ссылкам (перф-урок контроль-4 волны E).
        if (e.isSymbolicLink()) continue;
        await walk(abs);
        continue;
      }
      // Файл-ссылка тоже может указывать наружу (на .env, на ключ) — её содержимое не наше.
      if (e.isSymbolicLink()) continue;
      if (!ext.test(e.name) || SECRET_FILE.test(abs)) continue;
      scannedFiles += 1;
      let text = "";
      try {
        const st = await stat(abs);
        if (st.size > MAX_FILE_BYTES) continue;
        text = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      const rel = relative(root, abs).split(sep).join("/");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        // Длинную строку (минифицированный бандл, base64) матчим только по началу: полный прогон по
        // ней — самый дешёвый способ уронить процесс в бэктрекинг.
        const lineText = (lines[i] ?? "").slice(0, MAX_LINE_CHARS);
        if (!re.test(lineText)) continue;
        hits.push({ path: rel, line: i + 1, text: lineText.trim().slice(0, 300) });
        if (hits.length >= maxHits) {
          capped = true;
          return;
        }
      }
    }
  };

  await walk(start);
  return { hits, scannedFiles, capped };
}

/**
 * Файловые актуаторы (§6): прямое управление файлами на машине пользователя.
 *
 * Исполняется в main-процессе Electron (у него есть доступ к ФС, в отличие от
 * изолированного code-runner с CWD=temp). Это первоклассный путь «создать/прочитать/
 * править/удалить файл» — избыточно к code.run, но явно и без shell-интерполяции.
 *
 * Пути: абсолютные Windows-пути, относительные (от домашнего каталога), либо с
 * переменными окружения %VAR% и ведущим ~. Удаление НЕОБРАТИМО — confirm на сервере (§4).
 *
 * НИКОГДА (§0): не передавать/не логировать карточные и платёжные данные из файлов.
 */
import { type Dirent, promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { cutText, createLogger } from "@jarvis/shared";
import { type ContentSniff, decodeTextDetailed, sniffContent, textForSearchDetailed, type TextEncoding } from "./fs-content.js";
import { HEAD_SNIFF_BYTES, type LineWindow, TAIL_CHUNK_BYTES, WINDOW_WHOLE_FILE_CAP, applyLineWindow, dropPartialFirstLine, dropPartialLastLine, hasLineWindow, readHeadBytes, readTailBytes, splitLines, validateLineWindow } from "./fs-read-window.js";
import { DEFAULT_IGNORED_DIRS, EMPTY_GAPS, type SearchGaps, type SearchMatch, type SearchOptions, type SearchResult, type SearchStopReason, describeDirError, isExhausted, searchBudgetMs, searchNote, searchScanCap } from "./fs-search-report.js";
import { assertReadable, assertWritable, canonicalizePath, isAncestorOfSelf, isProtectedSelfPathFast, isSecretPathFast } from "./self-guard.js";

const log = createLogger("actuator:fs");

/** Бюджет обхода поддерева для рекурсивного self-guard (аудит ядра [11]). Щедрый: node_modules ловится
 * как СЕГМЕНТ пути на входе в каталог (без спуска внутрь), поэтому бюджет тратят лишь НЕ-защищённые
 * записи — в норме исчерпание не наступает. При исчерпании — fail-CLOSED (отказ), не «чисто». */
const TREE_GUARD_BUDGET = 200_000;

/**
 * Аудит ядра [11]: leaf-гард (assertWritable) проверял ТОЛЬКО сам путь — рекурсивное удаление/перемещение
 * КАТАЛОГА сносило/релоцировало node_modules/.env/запущенный бинарь ВНУТРИ поддерева в обход рельс.
 * Перед рекурсивной операцией над каталогом: (1) запрет предка запущенного бинаря; (2) ограниченный
 * скан поддерева — есть защищённое внутри → отказ (fail-closed). Для файла — обычный leaf-гард.
 */
async function assertTreeWritable(abs: string): Promise<void> {
  assertWritable(abs); // leaf-проверка самого пути (секрет/node_modules/бинарь как конечная цель)
  let isDir = false;
  try {
    isDir = (await fsp.stat(abs)).isDirectory();
  } catch {
    return; // нет пути — пусть операция сама отдаст честную ошибку
  }
  if (!isDir) return;
  if (isAncestorOfSelf(abs)) {
    throw new Error(
      `защита самосохранности (§): каталог «${abs}» содержит запущенный бинарь Джарвиса — рекурсивное удаление/перемещение отклонено.`,
    );
  }
  const budget = { n: TREE_GUARD_BUDGET, exhausted: false };
  const hit = await firstProtectedInTree(abs, budget);
  if (hit) {
    throw new Error(
      `защита самосохранности (§): каталог «${abs}» содержит защищённое («${hit}») — рекурсивное удаление/перемещение отклонено. Удаляй/двигай точечно.`,
    );
  }
  // Контрольный проход аудита [11]: бюджет исчерпан ДО полного обхода → мы НЕ можем гарантировать, что
  // внутри нет .env/node_modules/бинаря в непройденной ветке. FAIL-CLOSED: отказываем (а не «чисто»).
  if (budget.exhausted) {
    throw new Error(
      `защита самосохранности (§): каталог «${abs}» слишком большой для полной проверки поддерева (>${TREE_GUARD_BUDGET} записей) — рекурсивное удаление/перемещение отклонено (fail-closed). Удаляй/двигай точечно.`,
    );
  }
}

/**
 * Первый защищённый путь в поддереве (уровень целиком до спуска — node_modules/.env обычно наверху).
 * budget.exhausted взводится при исчерпании бюджета: null тогда ≠ «чисто», а «не смогли проверить».
 *
 * Контроль-4 волны E (HIGH): проверка КАЖДОЙ записи идёт БЫСТРЫМ (без realpath-сисколла) вариантом —
 * `dir`/`d.name` из `fsp.readdir()` уже канонические длинные имена (Windows не отдаёт 8.3-алиасы из
 * листинга), а топ-путь операции (`abs` в `assertTreeWritable`) уже прошёл канонизирующий
 * `assertWritable` ДО вызова этой функции. Полная (`isProtectedSelfPath`) канонизация на каждую из
 * до `TREE_GUARD_BUDGET`=200 000 записей морозила бы Electron main-процесс на секунды-минуты
 * (сеть/OneDrive — до SMB-таймаута) — сисколл здесь не даёт защиты сверх той, что уже есть.
 */
async function firstProtectedInTree(dir: string, budget: { n: number; exhausted: boolean }): Promise<string | null> {
  if (budget.n <= 0) {
    budget.exhausted = true;
    return null;
  }
  let ents: Dirent[];
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null; // нет доступа к каталогу — не наша забота (операция сама отдаст ошибку)
  }
  for (const d of ents) {
    budget.n -= 1;
    const full = join(dir, d.name);
    if (isProtectedSelfPathFast(full)) return full;
  }
  for (const d of ents) {
    if (budget.n <= 0) {
      budget.exhausted = true;
      return null;
    }
    if (d.isDirectory()) {
      const deeper = await firstProtectedInTree(join(dir, d.name), budget);
      if (deeper) return deeper;
      if (budget.exhausted) return null; // дальше проверять бессмысленно — уже не гарантируем чистоту
    }
  }
  return null;
}

/** Дефолтный лимит чтения (защита от загрузки гигантских файлов в память). */
const DEFAULT_MAX_READ = 2 * 1024 * 1024; // 2 МБ
/** Лимиты обхода для list/search. */
const MAX_LIST_ENTRIES = 5000;
const MAX_SEARCH_RESULTS = 200; // кап просмотренных файлов — в fs-search-report.ts (searchScanCap)

/** Раскрыть %VAR%, ведущий ~ и привести к абсолютному пути. */
/**
 * Переменные окружения, которые ИМЕЕТ СМЫСЛ раскрывать в пути. Ревью 2026-09-01 (MED): раскрытие ЛЮБОЙ %VAR%
 * отдавало значение переменной клиента в ТЕКСТЕ ошибки («корень «C:/Users/anton/<значение>» не существует») —
 * prompt-injected `fs_search{root:"%OBS_WEBSOCKET_PASSWORD%"}` читал секрет мимо всего денилиста self-guard
 * (он проверяет путь, а не то, откуда путь взялся). Не путевая переменная остаётся литералом.
 */
const PATH_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "USERPROFILE", "HOMEPATH", "HOMEDRIVE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PUBLIC", "ONEDRIVE",
  "ONEDRIVECONSUMER", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA", "ALLUSERSPROFILE",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "USERNAME", "COMPUTERNAME",
]);

export function expandPath(p: string): string {
  let s = p.trim().replace(/%([^%]+)%/g, (_m, name: string) => (PATH_ENV_ALLOWLIST.has(name.toUpperCase()) ? (process.env[name] ?? `%${name}%`) : `%${name}%`));
  if (s === "~" || s.startsWith(`~${sep}`) || s.startsWith("~/")) {
    s = join(homedir(), s.slice(1));
  }
  return isAbsolute(s) ? resolve(s) : resolve(homedir(), s);
}

export interface FsEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "other";
  size: number;
}

export interface ReadResult {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
  /** Как декодировано: utf8 / utf8-bom (BOM срезан) / utf16le / utf16be (по BOM). */
  encoding: TextEncoding;
  /** Честная пометка: часть байтов не легла в UTF-8 (в тексте «�») — вероятно, другая кодировка (cp1251?). */
  note?: string;
  /** Строк в файле — когда файл прочитан целиком или окном по строкам (при усечении по maxBytes не считаем: соврали бы). */
  totalLines?: number;
  /** Окно строк, если читали окном (offset/lines/tail): 1-based, включительно; пустое окно → to < from. */
  range?: { from: number; to: number };
}

export interface ReadOptions {
  /** Тесты: порог «файл огромный» для окна (деф. WINDOW_WHOLE_FILE_CAP). */
  wholeFileCap?: number;
  /** Тесты: размер хвоста для tail на огромном файле (деф. TAIL_CHUNK_BYTES). */
  tailChunkBytes?: number;
}

/**
 * Прочитать файл как ТЕКСТ. Бинарник (PDF/PNG/docx/exe… — по сигнатуре или содержимому) → ЧЕСТНАЯ
 * ошибка с классом файла и каналом, которым его читать (§3.9(б): раньше отдавался utf8-мусор без
 * ошибки, и модель «читала» документ из �-каши). UTF-16 с BOM — текст, декодируется. Пустой файл — не ошибка.
 */
export async function readFile(path: string, maxBytes = DEFAULT_MAX_READ, window?: LineWindow, opts?: ReadOptions): Promise<ReadResult> {
  const abs = expandPath(path);
  assertReadable(abs); // §0: не читаем .env-секреты в контекст модели
  if (hasLineWindow(window)) return readWindow(abs, window, Math.max(1, maxBytes), opts);
  const size = (await fsp.stat(abs)).size;
  // Ревью (MED): файл больше cap целиком в память НЕ поднимаем (1,5 ГБ дампа = OOM main-процесса Electron) —
  // читаем только голову в maxBytes; truncated считается от РЕАЛЬНОГО размера.
  // +4 байта к лимиту: усечение происходит ВНУТРИ буфера, и decodeTextDetailed сам срезает хвостовой обрубок
  // multibyte-символа до эвристики cp1251 (иначе «�» на конце включал ложную cp1251 — ревью HIGH, тот же класс).
  const buf = size > (opts?.wholeFileCap ?? WINDOW_WHOLE_FILE_CAP) ? await readHeadBytes(abs, Math.max(1, maxBytes) + 4) : await fsp.readFile(abs);
  const sniff = sniffContent(buf, extname(abs));
  if (sniff.kind === "binary") {
    log.info("fs.read: бинарник, текстом не отдаём", { path: abs, bytes: buf.length, type: sniff.type });
    throw new Error(`«${abs}» — бинарный файл (${sniff.type}): текстом не читается. ${sniff.hint}`);
  }
  if (sniff.kind === "empty") {
    log.info("fs.read", { path: abs, bytes: 0, truncated: false });
    return { path: abs, bytes: 0, truncated: false, encoding: "utf8", totalLines: 0, content: "" };
  }
  const limit = Math.min(buf.length, Math.max(1, maxBytes));
  const truncated = size > limit;
  const decoded = decodeTextDetailed(buf, sniff, limit);
  const encoding = decoded.encoding;
  // «�» в хвосте усечённого UTF-8 — разрезанный multibyte-символ, не чужая кодировка и НЕ содержимое файла:
  // из content его убираем (truncated и note уже говорят, что показано не всё), для note — тем более не считаем.
  const content = truncated && encoding.startsWith("utf8") ? decoded.text.replace(/�+$/u, "") : decoded.text;
  const probe = content;
  const notes: string[] = [];
  if (encoding === "cp1251") {
    notes.push("кодировка не UTF-8 — декодировано как cp1251 по эвристике (koi8-r/cp866 выглядели бы искажённо; тогда читать через code_run с явной кодировкой)");
  }
  if (encoding.startsWith("utf8") && probe.includes("�")) {
    notes.push("часть байтов не декодируется как UTF-8 (в тексте «�») — возможно, файл в другой кодировке (cp1251?); читать через code_run с явной кодировкой");
  }
  // UTF-16 нечётной длины: последний байт физически не образует код-юнит — отброшен, и это должно быть видно
  // (truncated:false обещает «прочитано всё»).
  if (!truncated && encoding.startsWith("utf16") && (buf.length - sniff.bomBytes) % 2 === 1) {
    notes.push("нечётная длина UTF-16 — последний байт файла отброшен (файл повреждён или дописан не по кодировке)");
  }
  // Причина №6: усечение с ПЕРВЫХ байт — почти всегда не то, что нужно (модели нужен хвост лога или диапазон).
  if (truncated) notes.push(`показаны первые ${limit} байт из ${size}; большой файл читай ОКНОМ — fs_read{offset,lines} или tail`);
  const note = notes.length > 0 ? notes.join("; ") : undefined;
  const totalLines = truncated ? undefined : splitLines(content).length; // при усечении счёт был бы ложным
  log.info("fs.read", { path: abs, bytes: size, truncated, encoding, ...(note ? { badUtf8: true } : {}) });
  // content — ПОСЛЕДНИМ: серверный кап режет JSON с хвоста, и поля честности (truncated/note/totalLines)
  // обязаны пережить обрезку (ревью MED: раньше отрезались ровно они).
  return { path: abs, bytes: size, truncated, encoding, ...(totalLines !== undefined ? { totalLines } : {}), ...(note ? { note } : {}), content };
}

/**
 * Чтение ОКНОМ строк (offset+lines / tail). Файл ≤ cap поднимается целиком (окно режется по строкам). Большой файл
 * целиком не читаем: tail — только хвостовой кусок (и на 6 МБ, и на 6 ГБ — split 32 МБ ради tail:10 лишний), lines
 * без offset — только голова, offset на файле > cap — честная ошибка с каналом. Кодировка большого файла
 * сниффится ПО ГОЛОВЕ (BOM только там; ревью MED: хвост UTF-16 с NUL-байтами объявлялся «бинарником»), кусок
 * начинается с ПОЛНОЙ строки на уровне байтов (ревью HIGH: обрубок UTF-8 включал ложную cp1251).
 * `maxChars` — кап на само окно (5000 строк по 10 КБ — тоже не в контекст).
 */
async function readWindow(abs: string, window: LineWindow, maxChars: number, opts?: ReadOptions): Promise<ReadResult> {
  const bad = validateLineWindow(window);
  if (bad) throw new Error(bad);
  const size = (await fsp.stat(abs)).size;
  const cap = opts?.wholeFileCap ?? WINDOW_WHOLE_FILE_CAP;
  const chunkBytes = opts?.tailChunkBytes ?? TAIL_CHUNK_BYTES;
  const ext = extname(abs);
  const mb = (n: number): string => `${Math.round((n / 1048576) * 10) / 10} МБ`;
  const useChunks = size > cap || (window.tail !== undefined && size > chunkBytes);
  let buf: Buffer;
  let sniff: ContentSniff;
  let mode: "whole" | "tail" | "head" = "whole";
  const notes: string[] = [];
  if (!useChunks) {
    buf = await fsp.readFile(abs);
    sniff = sniffContent(buf, ext);
  } else {
    const headSniff = sniffContent(await readHeadBytes(abs, HEAD_SNIFF_BYTES), ext);
    if (headSniff.kind === "binary") throw new Error(`«${abs}» — бинарный файл (${headSniff.type}): текстом не читается. ${headSniff.hint}`);
    if (headSniff.kind === "empty") return { path: abs, bytes: size, truncated: false, encoding: "utf8", totalLines: 0, range: { from: 1, to: 0 }, content: "" };
    const enc = headSniff.encoding === "utf8-bom" ? "utf8" : headSniff.encoding;
    if (window.tail !== undefined) {
      mode = "tail";
      const t = await readTailBytes(abs, size, chunkBytes, enc.startsWith("utf16") ? 2 : 1);
      const aligned = t.fromStart ? t.buf : dropPartialFirstLine(t.buf, enc);
      if (aligned === null) {
        // Ревью (LOW): «0 строк» у 40-МБ файла без объяснения — теперь причина названа.
        return {
          path: abs, bytes: size, truncated: true, encoding: enc,
          note: `файл ${mb(size)} — прочитан только хвост (${mb(chunkBytes)}), и в нём нет ни одной полной строки: строки длиннее куска (минифицированный JSON/одна строка?). Читай через code_run.`,
          content: "",
        };
      }
      buf = aligned;
      sniff = t.fromStart ? headSniff : { kind: "text", encoding: enc, bomBytes: 0 };
      if (!t.fromStart) notes.push(`файл ${mb(size)} — прочитан только хвост (${mb(buf.length)}); номера строк от начала файла не считаются`);
      else mode = "whole";
    } else if (window.offset === undefined) {
      mode = "head";
      const headChunk = await readHeadBytes(abs, chunkBytes);
      sniff = headSniff; // голова несёт BOM — bomBytes верны
      if (headChunk.length >= size) {
        buf = headChunk; // файл влез в кусок целиком — это обычное чтение с известными итогами
        mode = "whole";
      } else {
        const trimmed = dropPartialLastLine(headChunk, enc);
        if (trimmed === null) {
          return {
            path: abs, bytes: size, truncated: true, encoding: enc,
            note: `файл ${mb(size)} — прочитано только начало (${mb(chunkBytes)}), и в нём нет ни одной полной строки: строки длиннее куска. Читай через code_run.`,
            content: "",
          };
        }
        buf = trimmed;
        notes.push(`файл ${mb(size)} — прочитано только начало (${mb(buf.length)}); дальше по offset на таком файле не читаю: хвост — fs_read{tail}, произвольный кусок — code_run`);
      }
    } else {
      throw new Error(
        `«${abs}» — ${mb(size)}, больше ${mb(cap)}: окно по offset на таком файле не читаю (пришлось бы поднять его целиком). ` +
          "Начало — fs_read{lines:N}; хвост — fs_read{tail:N}; произвольный кусок — code_run (python: itertools.islice по строкам / PowerShell Get-Content -TotalCount|-Tail).",
      );
    }
  }
  if (sniff.kind === "binary") throw new Error(`«${abs}» — бинарный файл (${sniff.type}): текстом не читается. ${sniff.hint}`);
  if (sniff.kind === "empty") return { path: abs, bytes: size, truncated: false, encoding: "utf8", totalLines: 0, range: { from: 1, to: 0 }, content: "" };
  const decoded = decodeTextDetailed(buf, sniff, buf.length);
  if (decoded.encoding === "cp1251") notes.push("кодировка не UTF-8 — декодировано как cp1251 по эвристике");
  if (mode === "whole" && decoded.encoding.startsWith("utf16") && (buf.length - sniff.bomBytes) % 2 === 1) {
    notes.push("нечётная длина UTF-16 — последний байт файла отброшен (файл повреждён или дописан не по кодировке)");
  }
  const w = applyLineWindow(decoded.text, window);
  let content = w.content;
  let truncated = !w.complete || mode !== "whole";
  if (content.length > maxChars) {
    content = cutText(content, maxChars);
    truncated = true;
    notes.push(`окно обрезано до ${maxChars} символов (maxBytes) — уменьши lines`);
  }
  // В режиме куска «totalLines»/«выше ещё N строк» — счёт внутри куска, не файла (ревью LOW): не выдаём.
  if (mode === "whole" && w.note) notes.push(w.note);
  if (mode === "head" && !w.complete) notes.push(`показаны строки 1–${w.to} начала файла`);
  log.info("fs.read: окно", { path: abs, bytes: size, mode, from: w.from, to: w.to, totalLines: w.totalLines });
  return {
    path: abs,
    bytes: size,
    truncated,
    encoding: decoded.encoding,
    ...(mode === "whole" ? { totalLines: w.totalLines, range: { from: w.from, to: w.to } } : mode === "head" ? { range: { from: 1, to: w.to } } : {}),
    ...(notes.length ? { note: notes.join("; ") } : {}),
    content, // последним — см. readFile
  };
}

export async function writeFile(path: string, content: string, createDirs = false): Promise<{ path: string; bytes: number; created: boolean }> {
  const abs = expandPath(path);
  assertWritable(abs); // § рельсы: не перезаписываем критичное для Джарвиса (node_modules/.env/бинарь)
  const existed = await exists(abs);
  if (createDirs) await fsp.mkdir(dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, "utf8");
  log.info("fs.write", { path: abs, bytes: Buffer.byteLength(content), overwrote: existed });
  return { path: abs, bytes: Buffer.byteLength(content), created: !existed };
}

/**
 * Точечная правка файла (§6): заменить ТОЧНЫЙ фрагмент `old` на `new`, не перезаписывая весь файл.
 * Дешевле и безопаснее fs.write для больших файлов (правит код, а не регенерирует целиком). Честные
 * ошибки: фрагмент не найден / неоднозначен (встречается >1 раза без replaceAll) — НЕ молчаливый no-op.
 */
export async function editFile(
  path: string,
  oldStr: string,
  newStr: string,
  replaceAll = false,
): Promise<{ path: string; replacements: number; bytes: number }> {
  const abs = expandPath(path);
  assertWritable(abs); // § рельсы самомодификации
  if (oldStr === newStr) throw new Error("fs.edit: old и new одинаковы — нечего менять");
  if (oldStr === "") throw new Error("fs.edit: old пустой — нечего искать");
  const src = await fsp.readFile(abs, "utf8");
  const parts = src.split(oldStr);
  const count = parts.length - 1;
  if (count === 0) throw new Error("fs.edit: фрагмент не найден (нужно ТОЧНОЕ совпадение, включая пробелы/отступы)");
  if (count > 1 && !replaceAll) {
    throw new Error(`fs.edit: фрагмент встречается ${count} раз — добавь контекста для уникальности или передай replaceAll=true`);
  }
  // Без String.replace: он трактует $-паттерны в newStr. Склейка по split — буквальная.
  const next = replaceAll
    ? parts.join(newStr)
    : src.slice(0, src.indexOf(oldStr)) + newStr + src.slice(src.indexOf(oldStr) + oldStr.length);
  await fsp.writeFile(abs, next, "utf8");
  const replacements = replaceAll ? count : 1;
  log.info("fs.edit", { path: abs, replacements, bytes: Buffer.byteLength(next) });
  return { path: abs, replacements, bytes: Buffer.byteLength(next) };
}

export async function appendFile(path: string, content: string): Promise<{ path: string; bytes: number }> {
  const abs = expandPath(path);
  assertWritable(abs); // § рельсы самомодификации
  await fsp.appendFile(abs, content, "utf8");
  return { path: abs, bytes: Buffer.byteLength(content) };
}

export async function listDir(path: string, recursive = false): Promise<{ path: string; entries: FsEntry[]; truncated: boolean }> {
  const abs = expandPath(path);
  const entries: FsEntry[] = [];
  let truncated = false;
  const walk = async (dir: string): Promise<void> => {
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
      const full = join(dir, d.name);
      let size = 0;
      try { size = d.isFile() ? (await fsp.stat(full)).size : 0; } catch { /* нет доступа */ }
      entries.push({ name: d.name, path: full, type: d.isFile() ? "file" : d.isDirectory() ? "dir" : "other", size });
      if (recursive && d.isDirectory()) await walk(full);
    }
  };
  await walk(abs);
  return { path: abs, entries, truncated };
}

export async function deleteEntry(path: string, recursive = false): Promise<{ path: string; deleted: boolean }> {
  const abs = expandPath(path);
  // § рельсы: не даём удалить критичное для себя. Аудит [11]: рекурсивно — сверяем ВСЁ поддерево,
  // иначе rm(recursive) снёс бы node_modules/.env/бинарь внутри мимо leaf-гарда.
  if (recursive) await assertTreeWritable(abs);
  else assertWritable(abs);
  await fsp.rm(abs, { recursive, force: false });
  log.info("fs.delete", { path: abs, recursive });
  return { path: abs, deleted: true };
}

export async function moveEntry(from: string, to: string): Promise<{ from: string; to: string }> {
  const a = expandPath(from);
  const b = expandPath(to);
  // § рельсы: ни источник, ни приёмник не должны затрагивать критичное. Аудит [11]: rename/cp двигает
  // ВЕСЬ подкаталог источника — если это каталог с .env/node_modules/бинарём внутри, релокация обошла бы
  // и self-guard, и confirm (fs_move не confirm-гейтится). Поэтому источник сверяем поддеревом.
  await assertTreeWritable(a);
  assertWritable(b);
  await fsp.rename(a, b).catch(async (e: NodeJS.ErrnoException) => {
    // EXDEV — разные тома: копируем и удаляем.
    if (e.code === "EXDEV") { await fsp.cp(a, b, { recursive: true }); await fsp.rm(a, { recursive: true, force: true }); }
    else throw e;
  });
  return { from: a, to: b };
}

export async function makeDir(path: string): Promise<{ path: string }> {
  const abs = expandPath(path);
  await fsp.mkdir(abs, { recursive: true });
  return { path: abs };
}

export type { SearchMatch, SearchOptions, SearchResult, SearchStopReason } from "./fs-search-report.js";

/**
 * Поиск по имени/содержимому с ЧЕСТНЫМ отчётом о полноте (§3.3): `stopReason`/`scannedFiles`/`exhausted`/
 * `skippedDirs`/`note` — «не найдено» при `exhausted:false` НЕ значит «файла нет». Типы и тексты — в
 * `fs-search-report.ts`. Кап просмотренных файлов — `opts.scanCap` / env `JARVIS_FS_SEARCH_SCAN_CAP` / 20000.
 */
export async function search(root: string, query: string, inContent = false, maxResults = 50, opts?: SearchOptions): Promise<SearchResult> {
  // Контроль-5 волны E (HIGH): канонизируем КОРЕНЬ обхода ОДИН раз (не на каждую запись, как было бы
  // при полном canon() — это и есть регрессия, которую чинил контроль-4). Без этого junction/8.3-
  // алиас на ~/.aws/~/.ssh/~/.gnupg обходил бы directory-based денилист: full=join(root,d.name),
  // построенный от НЕканонического root, не содержит литеральной ".aws" — Fast per-entry regex молчит.
  const absRoot = canonicalizePath(expandPath(root));
  // Корень ВНУТРИ секретного каталога — честный отказ, а не молчаливое «ничего не найдено» (раньше
  // per-entry денилист выкидывал все записи и результат читался как «файлов нет»).
  assertReadable(absRoot);
  const scanCap = searchScanCap(opts);
  const budgetMs = searchBudgetMs(opts);
  const limit = Math.min(Math.max(1, maxResults), MAX_SEARCH_RESULTS);
  const needle = query.toLowerCase();
  const matches: SearchMatch[] = [];
  const gaps: SearchGaps = { ...EMPTY_GAPS };
  // Причина №6: служебные каталоги (node_modules/.git/dist…) НЕ обходим по умолчанию — они съедали кап целиком.
  const ignore = new Set((opts?.ignore ?? DEFAULT_IGNORED_DIRS).map((s) => String(s).toLowerCase()));
  let ignoredDirs = 0;
  const ignoredNames = new Map<string, string>(); // lower → как встретилось первым (Dist/dist — одно имя)
  let recodedFiles = 0;
  let files = 0;
  let stopReason: SearchStopReason | undefined;
  const startedAt = Date.now();
  // Порядок капов прежний: сперва результаты, потом просмотренные файлы, затем время; первый сработавший — причина.
  // Бюджет времени: inContent на реальном дереве шёл 129 с при таймауте действия 15 с (ревью 2026-09-01) —
  // модель получала error.timeout БЕЗ отчёта о полноте, а обход продолжал жечь диск в фоне.
  const capHit = (): boolean => {
    if (matches.length >= limit) { stopReason ??= "max_results"; return true; }
    if (files >= scanCap) { stopReason ??= "scan_cap"; return true; }
    if (Date.now() - startedAt >= budgetMs) { stopReason ??= "time_budget"; return true; }
    return false;
  };
  const walk = async (dir: string, isRoot: boolean): Promise<void> => {
    if (capHit()) return;
    let dirents: Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (isRoot) throw new Error(`fs.search: корень «${dir}» ${await describeDirError(dir, e)}.`);
      gaps.skippedDirs += 1; // недоступный каталог — тоже «не досмотрено» (раньше молчал)
      return;
    }
    for (const d of dirents) {
      // Кап и по результатам, и по числу просмотренных файлов — иначе в плоской папке с сотнями
      // тысяч файлов обход не останавливался (проверка files стояла только на входе в каталог).
      if (capHit()) return;
      const full = join(dir, d.name);
      // Ссылка/junction: по ней НЕ ходим (петли; алиас на секретный каталог мимо денилиста), но и не молчим —
      // раньше такая запись не оставляла следа, и exhausted:true объявлял «дерево пройдено до конца».
      if (d.isSymbolicLink()) { gaps.skippedLinks += 1; continue; }
      if (d.isDirectory()) {
        // Каталог тоже совпадает ПО ИМЕНИ («где папка jarvis?») — раньше папки не матчились, и на маленьком
        // дереве это давало уверенное «папки нет» при exhausted:true.
        if (!inContent && d.name.toLowerCase().includes(needle) && !isSecretPathFast(full) && matches.length < limit) {
          matches.push({ path: full, kind: "dir" });
        }
        // Совпадение по имени выше учтено (папку «dist» найти можно), а внутрь — нет: намеренно, и видимо в отчёте.
        if (ignore.has(d.name.toLowerCase())) {
          ignoredDirs += 1;
          if (!ignoredNames.has(d.name.toLowerCase())) ignoredNames.set(d.name.toLowerCase(), d.name);
          continue;
        }
        await walk(full, false);
        continue;
      }
      if (!d.isFile()) continue;
      files += 1;
      // Контроль-4: быстрый (без realpath-сисколла) вариант — full уже канонический (readdir), топ-путь
      // проверен вызывающим один раз; полная канонизация на каждый из scanCap=20000 файлов
      // морозила бы event loop без дополнительной защиты (см. firstProtectedInTree выше).
      if (isSecretPathFast(full)) continue; // §0: не отдаём секретные пути ни по имени, ни по содержимому
      if (!inContent) {
        if (d.name.toLowerCase().includes(needle)) matches.push({ path: full });
        continue;
      }
      try {
        // stat ДО чтения: гигантский файл раньше целиком поднимался в память и только потом отбрасывался.
        if ((await fsp.stat(full)).size > DEFAULT_MAX_READ) { gaps.oversizedFiles += 1; continue; }
        const decoded = textForSearchDetailed(await fsp.readFile(full), extname(d.name));
        if (decoded === null) continue; // бинарник — мусор не сканируем (декларация теперь совпадает с поведением)
        const text = decoded.text;
        // Не-UTF-8: похоже на cp1251 → прочитано по эвристике (ищем, но сообщаем); иначе — «�», кириллицу так не найти.
        if (decoded.encoding === "cp1251") recodedFiles += 1;
        else if (text.includes("\uFFFD")) gaps.undecodedFiles += 1;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i]!.toLowerCase().includes(needle)) {
            matches.push({ path: full, line: i + 1, preview: cutText(lines[i]!, 200) });
            break;
          }
        }
      } catch {
        gaps.unreadableFiles += 1; // занят/нет прав — «не смог прочитать» ≠ «иголки нет»
      }
    }
  };
  await walk(absRoot, true);
  const exhausted = isExhausted(stopReason, gaps);
  const ignoredList = [...ignoredNames.values()].slice(0, 12);
  const note = searchNote(stopReason, { scanCap, limit, budgetMs, scanned: files, recodedFiles, ignoredDirs, ignoredNames: ignoredList, ignoredDistinct: ignoredNames.size, customIgnore: opts?.ignore !== undefined, ...gaps });
  log.info("fs.search", { root: absRoot, inContent, matches: matches.length, scannedFiles: files, stopReason, exhausted, recodedFiles, ignoredDirs, ...gaps });
  // matches — ПОСЛЕДНИМ: серверный кап режет JSON с хвоста, а exhausted/stopReason/note обязаны пережить обрезку.
  return { truncated: stopReason !== undefined, ...(stopReason ? { stopReason } : {}), scannedFiles: files, recodedFiles, exhausted, ignoredDirs, ignoredNames: ignoredList, ...gaps, ...(note ? { note } : {}), matches };
}

async function exists(abs: string): Promise<boolean> {
  try { await fsp.access(abs); return true; } catch { return false; }
}

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
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createLogger } from "@jarvis/shared";
import { assertReadable, assertWritable, isAncestorOfSelf, isProtectedSelfPath, isSecretPath } from "./self-guard.js";

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

/** Первый защищённый путь в поддереве (уровень целиком до спуска — node_modules/.env обычно наверху).
 * budget.exhausted взводится при исчерпании бюджета: null тогда ≠ «чисто», а «не смогли проверить». */
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
    if (isProtectedSelfPath(full)) return full;
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
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILES = 20000;

/** Раскрыть %VAR%, ведущий ~ и привести к абсолютному пути. */
export function expandPath(p: string): string {
  let s = p.trim().replace(/%([^%]+)%/g, (_m, name) => process.env[name] ?? `%${name}%`);
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

export async function readFile(path: string, maxBytes = DEFAULT_MAX_READ): Promise<{ path: string; content: string; bytes: number; truncated: boolean }> {
  const abs = expandPath(path);
  assertReadable(abs); // §0: не читаем .env-секреты в контекст модели
  const buf = await fsp.readFile(abs);
  const limit = Math.min(buf.length, Math.max(1, maxBytes));
  const truncated = buf.length > limit;
  log.info("fs.read", { path: abs, bytes: buf.length, truncated });
  return { path: abs, content: buf.subarray(0, limit).toString("utf8"), bytes: buf.length, truncated };
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

export async function search(root: string, query: string, inContent = false, maxResults = 50): Promise<{ matches: Array<{ path: string; line?: number; preview?: string }>; truncated: boolean }> {
  const absRoot = expandPath(root);
  const limit = Math.min(Math.max(1, maxResults), MAX_SEARCH_RESULTS);
  const needle = query.toLowerCase();
  const matches: Array<{ path: string; line?: number; preview?: string }> = [];
  let files = 0;
  let truncated = false;
  const walk = async (dir: string): Promise<void> => {
    if (matches.length >= limit || files >= MAX_SEARCH_FILES) { truncated = true; return; }
    let dirents: import("node:fs").Dirent[];
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      // Кап и по результатам, и по числу просмотренных файлов — иначе в плоской папке с сотнями
      // тысяч файлов обход не останавливался (проверка files стояла только на входе в каталог).
      if (matches.length >= limit || files >= MAX_SEARCH_FILES) { truncated = true; return; }
      const full = join(dir, d.name);
      if (d.isDirectory()) { await walk(full); continue; }
      if (!d.isFile()) continue;
      files += 1;
      if (isSecretPath(full)) continue; // §0: не отдаём секретные пути ни по имени, ни по содержимому
      if (!inContent) {
        if (d.name.toLowerCase().includes(needle)) matches.push({ path: full });
        continue;
      }
      try {
        const buf = await fsp.readFile(full);
        if (buf.length > DEFAULT_MAX_READ) continue; // не сканируем гигантские/бинарные
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i]!.toLowerCase().includes(needle)) {
            matches.push({ path: full, line: i + 1, preview: lines[i]!.slice(0, 200) });
            break;
          }
        }
      } catch { /* нет доступа/бинарь */ }
    }
  };
  await walk(absRoot);
  return { matches, truncated };
}

async function exists(abs: string): Promise<boolean> {
  try { await fsp.access(abs); return true; } catch { return false; }
}

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
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createLogger } from "@jarvis/shared";

const log = createLogger("actuator:fs");

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
  const buf = await fsp.readFile(abs);
  const limit = Math.min(buf.length, Math.max(1, maxBytes));
  const truncated = buf.length > limit;
  log.info("fs.read", { path: abs, bytes: buf.length, truncated });
  return { path: abs, content: buf.subarray(0, limit).toString("utf8"), bytes: buf.length, truncated };
}

export async function writeFile(path: string, content: string, createDirs = false): Promise<{ path: string; bytes: number; created: boolean }> {
  const abs = expandPath(path);
  const existed = await exists(abs);
  if (createDirs) await fsp.mkdir(dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, "utf8");
  log.info("fs.write", { path: abs, bytes: Buffer.byteLength(content), overwrote: existed });
  return { path: abs, bytes: Buffer.byteLength(content), created: !existed };
}

export async function appendFile(path: string, content: string): Promise<{ path: string; bytes: number }> {
  const abs = expandPath(path);
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
  await fsp.rm(abs, { recursive, force: false });
  log.info("fs.delete", { path: abs, recursive });
  return { path: abs, deleted: true };
}

export async function moveEntry(from: string, to: string): Promise<{ from: string; to: string }> {
  const a = expandPath(from);
  const b = expandPath(to);
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
      if (matches.length >= limit) { truncated = true; return; }
      const full = join(dir, d.name);
      if (d.isDirectory()) { await walk(full); continue; }
      if (!d.isFile()) continue;
      files += 1;
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

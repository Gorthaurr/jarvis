/**
 * Виртуальная ФС FakeDesktop: пути и ЧТЕНИЕ дерева (индекс). Семантика — Windows/NTFS, как её отдаёт Node на ПК владельца
 * (сверено пробой на живом `fs`, Node 22): регистр имени сохраняется, но поиск нечувствителен к регистру; ошибки — того же
 * вида, что у настоящего клиента (`ENOENT: no such file or directory, open 'C:\…'`), потому что клиентский dispatch
 * отдаёт модели ровно `e.message`. Мутации — в vfs-ops.ts. Реальный диск не трогается никогда.
 */
import { posix } from "node:path";
import type { DesktopCore } from "./core.js";

export type VKind = "file" | "dir";
export interface VEntry {
  /** Путь как ХРАНИТСЯ (прямые слэши, диск в верхнем регистре, регистр имени — как создан). */
  p: string;
  name: string;
  kind: VKind;
  size: number;
}
export interface VIndex {
  /** Ключ — путь в нижнем регистре. */
  byPath: Map<string, VEntry>;
  /** Дочерние записи каталога (ключ — путь каталога в нижнем регистре), отсортированы по имени без учёта регистра. */
  kids: Map<string, VEntry[]>;
}

export const lower = (p: string): string => p.toLowerCase();

/** Путь в виде, который видит модель (обратные слэши; корень диска — «C:\»). */
export const winPath = (p: string): string => (/^[A-Za-z]:$/u.test(p) ? `${p}\\` : p.replace(/\//gu, "\\"));

const ERR_TEXT: Record<string, string> = {
  ENOENT: "no such file or directory",
  ENOTDIR: "not a directory",
  EISDIR: "illegal operation on a directory",
  EEXIST: "file already exists",
  EPERM: "operation not permitted",
  EBUSY: "resource busy or locked",
};

/** Ошибка ФС «как у Node»: `CODE: текст, syscall 'путь' [-> 'путь2']`. Путь опускается там, где его нет и у Node (read/write). */
export function fsError(code: string, syscall: string, path?: string, dest?: string): Error & { code: string } {
  const tail = path === undefined ? "" : ` '${winPath(path)}'${dest !== undefined ? ` -> '${winPath(dest)}'` : ""}`;
  return Object.assign(new Error(`${code}: ${ERR_TEXT[code] ?? code}, ${syscall}${tail}`), { code });
}

/**
 * Переменные, которые реальный `expandPath` раскрывает (PATH_ENV_ALLOWLIST в fs.ts), — со значениями ВИРТУАЛЬНОГО ПК.
 * Чужие %VAR% остаются литералом (иначе секреты окружения утекали бы в тексты ошибок).
 */
function virtualEnv(home: string): Record<string, string> {
  return {
    USERPROFILE: home, HOMEDRIVE: "C:", HOMEPATH: home.replace(/^[A-Za-z]:/u, ""),
    APPDATA: `${home}/AppData/Roaming`, LOCALAPPDATA: `${home}/AppData/Local`,
    TEMP: `${home}/AppData/Local/Temp`, TMP: `${home}/AppData/Local/Temp`,
    PUBLIC: "C:/Users/Public", PROGRAMFILES: "C:/Program Files", "PROGRAMFILES(X86)": "C:/Program Files (x86)",
    PROGRAMW6432: "C:/Program Files", PROGRAMDATA: "C:/ProgramData", ALLUSERSPROFILE: "C:/ProgramData",
    COMMONPROGRAMFILES: "C:/Program Files/Common Files", "COMMONPROGRAMFILES(X86)": "C:/Program Files (x86)/Common Files",
    SYSTEMROOT: "C:/Windows", WINDIR: "C:/Windows", SYSTEMDRIVE: "C:",
    USERNAME: home.slice(home.lastIndexOf("/") + 1), COMPUTERNAME: "LAB-PC",
  };
}

/** Нормализация абсолютного пути: `..` не выходит за корень диска, хвостовой слэш срезан, корень диска = «C:». */
function normalizeAbs(s: string): string {
  const m = /^([A-Za-z]:)(\/.*)?$/u.exec(s);
  const drive = m ? m[1]!.toUpperCase() : "C:";
  const rest = posix.normalize(`/${m ? (m[2] ?? "/") : s}`);
  return rest === "/" ? drive : drive + rest.replace(/\/$/u, "");
}

/** Аналог `expandPath` из fs.ts: %VAR% (allowlist) → `~` → относительный от домашней папки → нормализация. */
export function expandPath(core: DesktopCore, p: string): string {
  const env = virtualEnv(core.fs.home);
  let s = p.trim().replace(/%([^%]+)%/gu, (m, name: string) => env[name.toUpperCase()] ?? m).replace(/\\/gu, "/");
  if (s === "~" || s.startsWith("~/")) s = core.fs.home + s.slice(1);
  if (/^[A-Za-z]:(?:\/|$)/u.test(s)) return normalizeAbs(s);
  if (s.startsWith("/")) return normalizeAbs(`C:${s}`);
  return normalizeAbs(`${core.fs.home}/${s}`);
}

/** Имя с символами, которых Windows не допускает (`<>:"|?*`): любое создание → ENOENT (проверено пробой). Диск «C:» — не в счёт. */
export function hasInvalidName(abs: string): boolean {
  return /[<>:"|?*]/u.test(abs.replace(/^[A-Za-z]:/u, ""));
}

export function parentOf(p: string): string | null {
  const i = p.lastIndexOf("/");
  if (i < 0) return null;
  return i <= 2 && /^[A-Za-z]:/u.test(p) ? p.slice(0, 2) : p.slice(0, i);
}

/** Индекс дерева: каталоги без записи в `dirs` (предки файлов, положенных прямо в `core.fs.files`) считаются существующими. */
export function buildIndex(core: DesktopCore): VIndex {
  const byPath = new Map<string, VEntry>();
  const kids = new Map<string, VEntry[]>();
  const link = (e: VEntry): void => {
    byPath.set(lower(e.p), e);
    const par = parentOf(e.p);
    if (par !== null) {
      const k = lower(par);
      const list = kids.get(k);
      if (list) list.push(e);
      else kids.set(k, [e]);
    }
  };
  const ensureDir = (p: string): void => {
    if (byPath.has(lower(p))) return;
    const par = parentOf(p);
    if (par !== null) ensureDir(par);
    link({ p, name: p.slice(p.lastIndexOf("/") + 1), kind: "dir", size: 0 });
  };
  ensureDir("C:");
  for (const d of core.fs.dirs) ensureDir(d);
  for (const [p, buf] of core.fs.files) {
    if (byPath.has(lower(p))) continue;
    const par = parentOf(p);
    if (par !== null) ensureDir(par);
    link({ p, name: p.slice(p.lastIndexOf("/") + 1), kind: "file", size: buf.length });
  }
  for (const list of kids.values()) list.sort((a, b) => lower(a.name).localeCompare(lower(b.name)));
  return { byPath, kids };
}

export function tryStat(core: DesktopCore, abs: string, idx: VIndex = buildIndex(core)): VEntry | null {
  return idx.byPath.get(lower(abs)) ?? null;
}

export function statOf(core: DesktopCore, abs: string, syscall: string, idx?: VIndex): VEntry {
  const e = tryStat(core, abs, idx);
  if (!e) throw fsError("ENOENT", syscall, abs);
  return e;
}

/** Содержимое каталога (как `readdir`): нет → ENOENT scandir, файл → ENOTDIR scandir. */
export function readdir(core: DesktopCore, abs: string, idx: VIndex = buildIndex(core)): VEntry[] {
  const e = statOf(core, abs, "scandir", idx);
  if (e.kind !== "dir") throw fsError("ENOTDIR", "scandir", abs);
  return idx.kids.get(lower(e.p)) ?? [];
}

/** Байты файла: нет → ENOENT open, каталог → EISDIR read (как `fsp.readFile`). */
export function readBuf(core: DesktopCore, abs: string, idx?: VIndex): Buffer {
  const e = statOf(core, abs, "open", idx);
  if (e.kind === "dir") throw fsError("EISDIR", "read");
  return core.fs.files.get(e.p) ?? Buffer.alloc(0);
}

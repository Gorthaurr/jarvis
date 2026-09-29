/**
 * Виртуальная ФС: МУТАЦИИ (запись/mkdir/удаление/переименование) с семантикой Node на Windows — коды ошибок сверены пробой
 * на живом `fs` (см. vfs.ts). Каждая операция целиком либо применяется, либо бросает ДО изменений (частичных записей нет).
 */
import type { DesktopCore } from "./core.js";
import { type VEntry, type VIndex, buildIndex, fsError, hasInvalidName, lower, parentOf, winPath } from "./vfs.js";

/** Явно записать предков в `dirs`: иначе после удаления последнего файла «неявный» каталог исчезнет вместе с ним. */
function materialize(core: DesktopCore, idx: VIndex, abs: string): void {
  let par = parentOf(abs);
  while (par !== null && par.length > 2) {
    core.fs.dirs.add(idx.byPath.get(lower(par))?.p ?? par);
    par = parentOf(par);
  }
}

/** `mkdir -p`. Возвращает, создали ли хоть один каталог. Файл на пути: последний сегмент → EEXIST, промежуточный → ENOTDIR. */
export function mkdirp(core: DesktopCore, abs: string): boolean {
  if (hasInvalidName(abs)) throw fsError("ENOENT", "mkdir", abs);
  const idx = buildIndex(core);
  const segs = abs.split("/");
  let cur = segs[0]!;
  if (!idx.byPath.has(lower(cur))) throw fsError("ENOENT", "mkdir", abs);
  let created = false;
  for (let i = 1; i < segs.length; i += 1) {
    const next = `${cur}/${segs[i]}`;
    const e = idx.byPath.get(lower(next));
    if (e) {
      if (e.kind === "file") throw fsError(i === segs.length - 1 ? "EEXIST" : "ENOTDIR", "mkdir", e.p);
      cur = e.p;
      continue;
    }
    core.fs.dirs.add(next);
    created = true;
    cur = next;
  }
  return created;
}

/**
 * `writeFile`/`appendFile` (append создаёт файл, если его нет). Родитель обязан быть каталогом (иначе ENOENT open, в т.ч. когда
 * «родитель» — файл); каталог на месте файла → EISDIR (у write — с путём, у append — без, как у Node).
 */
export function writeBuf(core: DesktopCore, abs: string, data: Buffer, o: { append?: boolean; createDirs?: boolean } = {}): void {
  if (hasInvalidName(abs)) throw fsError("ENOENT", "open", abs);
  if (o.createDirs) mkdirp(core, parentOf(abs) ?? abs);
  const idx = buildIndex(core);
  const cur = idx.byPath.get(lower(abs));
  if (cur?.kind === "dir") throw o.append ? fsError("EISDIR", "write") : fsError("EISDIR", "open", abs);
  let key = cur?.p;
  if (!key) {
    const par = idx.byPath.get(lower(parentOf(abs) ?? ""));
    if (!par || par.kind !== "dir") throw fsError("ENOENT", "open", abs);
    key = `${par.p}/${abs.slice(abs.lastIndexOf("/") + 1)}`;
    materialize(core, idx, key);
  }
  const prev = core.fs.files.get(key);
  core.fs.files.set(key, o.append && prev ? Buffer.concat([prev, data]) : data);
}

export interface RmInfo {
  kind: "file" | "dir";
  /** Сколько записей снесено (файл — 1; каталог — он сам и всё внутри). */
  entries: number;
}

/**
 * `fsp.rm({force:false})` — НЕОБРАТИМО (у клиента нет корзины). Каталог без recursive → ERR_FS_EISDIR даже пустой; нет пути →
 * ENOENT lstat.
 */
export function rm(core: DesktopCore, abs: string, recursive: boolean): RmInfo {
  const idx = buildIndex(core);
  const e = idx.byPath.get(lower(abs));
  if (!e) throw fsError("ENOENT", "lstat", abs);
  if (e.kind === "file") {
    materialize(core, idx, e.p);
    core.fs.files.delete(e.p);
    return { kind: "file", entries: 1 };
  }
  if (!recursive) {
    throw Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${winPath(abs)}`), { code: "ERR_FS_EISDIR" });
  }
  if (e.p.length <= 2) throw fsError("EPERM", "rmdir", e.p);
  materialize(core, idx, e.p);
  const pre = `${lower(e.p)}/`;
  let entries = 1;
  for (const k of [...core.fs.files.keys()]) if (lower(k).startsWith(pre)) { core.fs.files.delete(k); entries += 1; }
  for (const k of [...core.fs.dirs]) {
    if (lower(k) === lower(e.p) || lower(k).startsWith(pre)) {
      core.fs.dirs.delete(k);
      if (lower(k) !== lower(e.p)) entries += 1;
    }
  }
  return { kind: "dir", entries };
}

function rekey(core: DesktopCore, from: string, to: string): void {
  const lf = lower(from);
  const inside = (k: string): boolean => lower(k) === lf || lower(k).startsWith(`${lf}/`);
  for (const [k, v] of [...core.fs.files]) if (inside(k)) { core.fs.files.delete(k); core.fs.files.set(to + k.slice(from.length), v); }
  for (const k of [...core.fs.dirs]) if (inside(k)) { core.fs.dirs.delete(k); core.fs.dirs.add(to + k.slice(from.length)); }
}

/**
 * `fsp.rename` на Windows: файл поверх файла — ПЕРЕЗАПИСЬ; поверх каталога — EPERM; каталог поверх каталога — EPERM (даже пустого);
 * каталог поверх файла — заменяет его; каталог внутрь себя — EBUSY (прямой потомок) / EPERM; только смена регистра — можно.
 * Возвращает, затёрли ли существующую цель.
 */
export function rename(core: DesktopCore, a: string, b: string): { replaced: boolean; kind: "file" | "dir" } {
  if (hasInvalidName(b)) throw fsError("ENOENT", "rename", a, b);
  const idx = buildIndex(core);
  const src = idx.byPath.get(lower(a));
  if (!src) throw fsError("ENOENT", "rename", a, b);
  const par = idx.byPath.get(lower(parentOf(b) ?? ""));
  if (!par || par.kind !== "dir") throw fsError("ENOENT", "rename", a, b);
  if (src.p.length <= 2) throw fsError("EPERM", "rename", a, b);
  const dst = idx.byPath.get(lower(b));
  const caseOnly = lower(a) === lower(b);
  if (!caseOnly) {
    if (dst?.kind === "dir") throw fsError("EPERM", "rename", a, b);
    if (src.kind === "dir" && lower(b).startsWith(`${lower(src.p)}/`)) {
      throw fsError(parentOf(b) !== null && lower(parentOf(b)!) === lower(src.p) ? "EBUSY" : "EPERM", "rename", a, b);
    }
  }
  materialize(core, idx, src.p);
  if (dst && !caseOnly) core.fs.files.delete(dst.p);
  const to = `${par.p}/${b.slice(b.lastIndexOf("/") + 1)}`;
  rekey(core, src.p, to);
  if (src.kind === "dir") core.fs.dirs.add(to);
  return { replaced: dst !== undefined && !caseOnly, kind: src.kind };
}

export type { VEntry };

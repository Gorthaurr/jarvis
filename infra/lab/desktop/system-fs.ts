/**
 * Обработчики fs.* FakeDesktop: тонкая склейка «команда → операция над виртуальной ФС → ответ + эффект». Порядок проверок,
 * тексты и формы ответов — как у fs.ts клиента (там их и смотри). Намеренно воспроизведены НЕДОСТАТКИ боевого актуатора, чтобы
 * лаборатория не давала «зелёного» там, где живьём красное: edit/append читают и пишут utf8 без sniff (cp1251/UTF-16 портятся
 * молча — fs.ts:342), запись не атомарна и без BOM, delete необратим (корзины нет), list/mkdir без рельс самосохранности.
 */
import type { DesktopCore, KindHandlers } from "./core.js";
import { handler } from "./system-common.js";
import { readText } from "./system-fs-read.js";
import { listTree, searchTree } from "./system-fs-tree.js";
import { viewVirtual } from "./system-fs-view.js";
import { assertTreeWritable, guardWrite } from "./vfs-guard.js";
import { mkdirp, rename, rm, writeBuf } from "./vfs-ops.js";
import { expandPath, readBuf, tryStat, winPath } from "./vfs.js";

export function fsHandlers(core: DesktopCore): KindHandlers {
  /** Путь в виде, как он лежит в снимке (канонический регистр) — по нему eval сверяет эффекты со `snapshot().files`. */
  const key = (abs: string): string => tryStat(core, abs)?.p ?? abs;
  return {
    "fs.read": handler<"fs.read">(core, (c) => readText(core, c.path, c.maxBytes, { offset: c.offset, lines: c.lines, tail: c.tail })),
    "fs.view": handler<"fs.view">(core, (c) => viewVirtual(core, c.path, { page: c.page, maxSide: c.maxSide })),
    "fs.list": handler<"fs.list">(core, (c) => listTree(core, c.path, c.recursive)),
    "fs.search": handler<"fs.search">(core, (c) => searchTree(core, c.root, c.query, c.inContent, c.maxResults, Array.isArray(c.ignore) ? { ignore: c.ignore.map(String) } : undefined)),

    "fs.write": handler<"fs.write">(core, (c) => {
      const abs = expandPath(core, c.path);
      guardWrite(abs);
      const existed = tryStat(core, abs) !== null;
      const data = Buffer.from(c.content, "utf8");
      writeBuf(core, abs, data, { createDirs: c.createDirs });
      core.effect("fs.write", { path: key(abs), bytes: data.length, created: !existed });
      return { path: winPath(abs), bytes: data.length, created: !existed };
    }),

    "fs.edit": handler<"fs.edit">(core, (c) => {
      const abs = expandPath(core, c.path);
      guardWrite(abs);
      if (c.old === c.new) throw new Error("fs.edit: old и new одинаковы — нечего менять");
      if (c.old === "") throw new Error("fs.edit: old пустой — нечего искать");
      const src = readBuf(core, abs).toString("utf8"); // как fs.ts: чтение utf8 без sniff — не-UTF-8 файл портится
      const parts = src.split(c.old);
      const count = parts.length - 1;
      if (count === 0) throw new Error("fs.edit: фрагмент не найден (нужно ТОЧНОЕ совпадение, включая пробелы/отступы)");
      if (count > 1 && !c.replaceAll) throw new Error(`fs.edit: фрагмент встречается ${count} раз — добавь контекста для уникальности или передай replaceAll=true`);
      const at = src.indexOf(c.old);
      const next = c.replaceAll ? parts.join(c.new) : src.slice(0, at) + c.new + src.slice(at + c.old.length);
      const data = Buffer.from(next, "utf8");
      writeBuf(core, abs, data);
      const replacements = c.replaceAll ? count : 1;
      core.effect("fs.edit", { path: key(abs), replacements, bytes: data.length });
      return { path: winPath(abs), replacements, bytes: data.length };
    }),

    "fs.append": handler<"fs.append">(core, (c) => {
      const abs = expandPath(core, c.path);
      guardWrite(abs);
      const data = Buffer.from(c.content, "utf8");
      writeBuf(core, abs, data, { append: true });
      core.effect("fs.append", { path: key(abs), bytes: data.length, totalBytes: readBuf(core, abs).length });
      return { path: winPath(abs), bytes: data.length };
    }),

    "fs.delete": handler<"fs.delete">(core, (c) => {
      const abs = expandPath(core, c.path);
      if (c.recursive) assertTreeWritable(core, abs);
      else guardWrite(abs);
      const was = key(abs);
      const info = rm(core, abs, c.recursive === true);
      core.effect("fs.delete", { path: was, type: info.kind, entries: info.entries, recursive: c.recursive === true, permanent: true });
      return { path: winPath(abs), deleted: true };
    }),

    "fs.move": handler<"fs.move">(core, (c) => {
      const a = expandPath(core, c.from);
      const b = expandPath(core, c.to);
      assertTreeWritable(core, a);
      guardWrite(b);
      const was = key(a);
      const r = rename(core, a, b);
      core.effect("fs.move", { from: was, to: key(b), type: r.kind, replaced: r.replaced });
      return { from: winPath(a), to: winPath(b) };
    }),

    "fs.mkdir": handler<"fs.mkdir">(core, (c) => {
      const abs = expandPath(core, c.path);
      const created = mkdirp(core, abs);
      core.effect("fs.mkdir", { path: key(abs), created });
      return { path: winPath(abs) };
    }),
  };
}

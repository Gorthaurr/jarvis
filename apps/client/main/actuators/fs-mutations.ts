/** Existing text-write semantics, with byte snapshots around successful changes. Paths are expanded by fs.ts. */
import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "@jarvis/shared";
import { assertWritable } from "./self-guard.js";
import { withFileUndo } from "./fs-undo.js";
import { fileHash } from "./fs-undo-file.js";

const log = createLogger("actuator:fs");
export function writeText(abs: string, content: string, createDirs: boolean) {
  assertWritable(abs);
  return withFileUndo(abs, "fs.write", async () => {
    const existed = await fsp.stat(abs).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return false; throw e; });
    if (createDirs) await fsp.mkdir(dirname(abs), { recursive: true });
    assertWritable(abs);
    await fsp.writeFile(abs, content, "utf8");
    const bytes = Buffer.byteLength(content);
    log.info("fs.write", { path: abs, bytes, overwrote: existed });
    return { result: { path: abs, bytes, created: !existed }, expectedHash: fileHash(content) };
  });
}

export function editText(abs: string, oldStr: string, newStr: string, replaceAll: boolean) {
  assertWritable(abs);
  return withFileUndo(abs, "fs.edit", async () => {
    if (oldStr === newStr) throw new Error("fs.edit: old и new одинаковы — нечего менять");
    if (oldStr === "") throw new Error("fs.edit: old пустой — нечего искать");
    const src = await fsp.readFile(abs, "utf8");
    const parts = src.split(oldStr);
    const count = parts.length - 1;
    if (count === 0) throw new Error("fs.edit: фрагмент не найден (нужно ТОЧНОЕ совпадение, включая пробелы/отступы)");
    if (count > 1 && !replaceAll) throw new Error(`fs.edit: фрагмент встречается ${count} раз — добавь контекста для уникальности или передай replaceAll=true`);
    const next = replaceAll ? parts.join(newStr) : src.slice(0, src.indexOf(oldStr)) + newStr + src.slice(src.indexOf(oldStr) + oldStr.length);
    assertWritable(abs);
    await fsp.writeFile(abs, next, "utf8");
    const replacements = replaceAll ? count : 1;
    const bytes = Buffer.byteLength(next);
    log.info("fs.edit", { path: abs, replacements, bytes });
    return { result: { path: abs, replacements, bytes }, expectedHash: fileHash(next) };
  });
}

export function appendText(abs: string, content: string) {
  assertWritable(abs);
  return withFileUndo(abs, "fs.append", async (before) => {
    assertWritable(abs);
    await fsp.appendFile(abs, content, "utf8");
    return { result: { path: abs, bytes: Buffer.byteLength(content) }, expectedHash: before ? fileHash(before.bytes, content) : undefined };
  });
}

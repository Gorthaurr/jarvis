/** Bounded raw snapshots. Handles pin identity; path/hash checks refuse stale undo.
 * External writers are not locked by Node: this is not an OS-wide atomic CAS. */
import { createHash } from "node:crypto";
import { promises as fsp, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertReadable, assertWritable } from "./self-guard.js";

export const MAX_UNDO_BYTES = 1024 * 1024;
export interface FileSnapshot { path: string; canonical: string; identity: string; bytes: Buffer; hash: string }
const identity = (s: BigIntStats): string => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
export function fileHash(...parts: (Buffer | string)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}
const samePath = (a: string, b: string): boolean => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const unchanged = (a: BigIntStats, b: BigIntStats): boolean => identity(a) === identity(b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function checkedPath(path: string): Promise<string> {
  assertReadable(path);
  assertWritable(path);
  for (let cursor = resolve(path);; cursor = dirname(cursor)) {
    if ((await fsp.lstat(cursor)).isSymbolicLink()) throw new Error("ссылка или junction в пути — восстановление не поддерживается");
    if (dirname(cursor) === cursor) break;
  }
  const canonical = await fsp.realpath(path);
  assertReadable(canonical);
  assertWritable(canonical);
  return canonical;
}

async function boundedRead(handle: FileHandle): Promise<{ bytes: Buffer; stat: BigIntStats }> {
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.ino === 0n) throw new Error("нужен обычный файл с одной ссылкой и проверяемой идентичностью");
  if (stat.size > BigInt(MAX_UNDO_BYTES)) throw new Error("файл больше 1 MiB — снимок для отмены не сохранён");
  const buffer = Buffer.alloc(Number(stat.size) + 1);
  let count = 0;
  while (count < buffer.length) {
    const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
    if (!bytesRead) break;
    count += bytesRead;
  }
  if (BigInt(count) !== stat.size || !unchanged(stat, await handle.stat({ bigint: true }))) throw new Error("файл менялся во время чтения снимка");
  return { bytes: buffer.subarray(0, count), stat };
}

async function openSnapshot(path: string, mode: "r" | "r+"): Promise<{ snapshot: FileSnapshot; handle: FileHandle }> {
  const canonical = await checkedPath(path);
  const entry = await fsp.lstat(path, { bigint: true });
  if (!entry.isFile()) throw new Error("отмена доступна только для обычного файла");
  const handle = await fsp.open(path, mode);
  try {
    const { bytes, stat } = await boundedRead(handle);
    if (identity(entry) !== identity(stat) || !samePath(canonical, await checkedPath(path)) || identity(await fsp.lstat(path, { bigint: true })) !== identity(stat)) {
      throw new Error("файл или путь подменён во время проверки");
    }
    return { snapshot: { path, canonical, identity: identity(stat), bytes, hash: fileHash(bytes) }, handle };
  } catch (error) { await handle.close(); throw error; }
}

export async function snapshotFile(path: string): Promise<FileSnapshot> {
  const { snapshot, handle } = await openSnapshot(path, "r");
  await handle.close();
  return snapshot;
}

export async function restoreFile(before: FileSnapshot, after: FileSnapshot): Promise<void> {
  const { snapshot: current, handle } = await openSnapshot(before.path, "r+");
  try {
    if (!samePath(current.canonical, after.canonical) || current.identity !== after.identity || current.hash !== after.hash) {
      throw new Error("файл изменён или подменён после действия Джарвиса — восстановление отклонено");
    }
    // Positional writes keep checking/reading independent of descriptor offsets.
    let offset = 0;
    while (offset < before.bytes.length) {
      const { bytesWritten } = await handle.write(before.bytes, offset, before.bytes.length - offset, offset);
      if (!bytesWritten) throw new Error("запись восстановления остановилась — исход неизвестен");
      offset += bytesWritten;
    }
    await handle.truncate(before.bytes.length);
    await handle.sync();
    const restored = await boundedRead(handle);
    if (fileHash(restored.bytes) !== before.hash || identity(restored.stat) !== before.identity ||
        !samePath(await checkedPath(before.path), before.canonical) || identity(await fsp.lstat(before.path, { bigint: true })) !== before.identity) {
      throw new Error("обратное чтение не подтвердило восстановление — исход неизвестен");
    }
  } finally { await handle.close(); }
}

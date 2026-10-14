/** Process-local undo for bounded existing-file writes. Never exposes saved bytes. */
import { randomUUID } from "node:crypto";
import { AsyncMutex } from "@jarvis/shared";
import { MAX_UNDO_BYTES, restoreFile, snapshotFile, type FileSnapshot } from "./fs-undo-file.js";

export interface UndoInfo { undoAvailable: boolean; undoId?: string; note?: string }
export interface UndoMetadata { id: string; path: string; operation: string; createdAt: string; bytes: number }
interface Entry { metadata: UndoMetadata; before: FileSnapshot; after: FileSnapshot }
const journal: Entry[] = [];
export const fileMutationMutex = new AsyncMutex();
const LIMIT = 10;
const note = (error: unknown): string => {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "новый или отсутствующий файл — отмена создания не поддерживается";
  return error instanceof Error ? error.message : "снимок файла недоступен";
};

/** Caller supplies the actual mutation; failures never publish an undo entry. */
export function withFileUndo<T>(path: string, operation: string, mutate: (before?: FileSnapshot) => Promise<{ result: T; expectedHash?: string }>): Promise<T & UndoInfo> {
  return fileMutationMutex.run(async () => {
    let before: FileSnapshot | undefined;
    let skipped = "";
    try { before = await snapshotFile(path); } catch (error) { skipped = note(error); }
    const { result, expectedHash } = await mutate(before);
    if (!before) return { ...result, undoAvailable: false, note: `Отмена недоступна: ${skipped}.` };
    try {
      const after = await snapshotFile(path);
      if (after.canonical !== before.canonical || after.identity !== before.identity) throw new Error("файл подменён во время изменения");
      if (!expectedHash || after.hash !== expectedHash) throw new Error("содержимое после записи не совпадает с ожидаемым — возможна сторонняя правка");
      if (after.hash === before.hash) return { ...result, undoAvailable: false, note: "Содержимое не изменилось — отменять нечего." };
      const metadata = { id: randomUUID(), path, operation, createdAt: new Date().toISOString(), bytes: before.bytes.length };
      journal.push({ metadata, before, after: { ...after, bytes: Buffer.alloc(0) } });
      const evicted = journal.length > LIMIT;
      if (evicted) journal.shift();
      return { ...result, undoAvailable: true, undoId: metadata.id,
        ...(evicted ? { note: "Доступны последние 10 изменений; самый старый снимок удалён." } : {}) };
    } catch (error) { return { ...result, undoAvailable: false, note: `Изменение выполнено, но отмена недоступна: ${note(error)}.` }; }
  });
}

export async function fileUndo(op: "list" | "restore", id?: string) {
  return fileMutationMutex.run(async () => {
    if (op === "list") return { entries: journal.slice().reverse().map((e) => ({ ...e.metadata })), limit: LIMIT, maxFileBytes: MAX_UNDO_BYTES, volatile: true };
    if (op !== "restore" || !id?.trim()) throw new Error("fs.undo: для восстановления нужен точный id из списка изменений");
    const entry = journal.find((e) => e.metadata.id === id);
    if (!entry) throw new Error("fs.undo: id неизвестен, уже восстановлен или снимок истёк; другой файл не изменён");
    await restoreFile(entry.before, entry.after);
    journal.splice(journal.indexOf(entry), 1);
    return { restored: true, id, path: entry.metadata.path, bytes: entry.before.bytes.length, verified: true };
  });
}

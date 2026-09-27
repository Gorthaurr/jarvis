/**
 * Одна попытка дописать порцию durable-лога (для `durable-append.ts`). р1 ревью C4/B5 (27.09): каталог логов
 * создавался только в конструкторе sink — удалили его на ходу («почистить логи», code_run) → ENOENT на основном
 * И запасном (они в одном каталоге) до перезапуска процесса. Теперь на ENOENT пересоздаём каталог и повторяем
 * ОДИН раз — только после этого это сбой. mkdir сам может упасть (права, диск) — тогда отдаём исходную ошибку.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function attempt(file: string, data: string): NodeJS.ErrnoException | null {
  try {
    appendFileSync(file, data);
    return null;
  } catch (e) {
    return e instanceof Error ? (e as NodeJS.ErrnoException) : new Error(String(e));
  }
}

/** Ошибка записи или null, если строки легли. */
export function tryAppend(file: string, data: string): NodeJS.ErrnoException | null {
  const err = attempt(file, data);
  if (err?.code !== "ENOENT") return err;
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return err;
  }
  return attempt(file, data);
}

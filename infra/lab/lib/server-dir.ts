/**
 * Каталог прогона лаб-сервера: проверка безопасности пути и удаление только СВОЕГО каталога (по маркеру).
 * Боевые данные владельца (apps/server/data, %APPDATA%/@jarvis) сюда попасть не могут: такой путь отвергается на входе.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ROOT } from "./deps.js";
import { labRoot } from "./server-state.js";

export const MARKER = ".jarvis-lab";

const norm = (p: string): string => p.split("\\").join("/").replace(/\/+$/u, "");

/** Путь пригоден для env-файла и sherpa/PGlite: ASCII, без пробелов и `#`/кавычек. */
export function assertPlainPath(dir: string): void {
  if (!/^[A-Za-z0-9_:./-]+$/u.test(dir)) {
    throw new Error(`каталог лаборатории «${dir}» должен быть ASCII без пробелов/#/кавычек (env-файл, PGlite и sherpa ломаются на других путях) — задай opts.dir`);
  }
}

/** Каталог не должен затрагивать репозиторий и данные владельца; существующий непустой чужой каталог не берём. */
export function assertSafeDir(dir: string, appdata = process.env.APPDATA): void {
  const d = norm(dir).toLowerCase();
  const root = norm(ROOT).toLowerCase();
  const bad = [root, `${root}/apps`, `${root}/packages`, `${root}/infra`].some((b) => d === b || d.startsWith(`${b}/`) && !d.startsWith(`${root}/infra/lab/tmp`));
  const owner = appdata ? norm(appdata).toLowerCase() : "";
  if (bad || d.includes("@jarvis") || (owner && (d === owner || d.startsWith(`${owner}/`)))) {
    throw new Error(`каталог «${dir}» внутри репозитория или данных владельца — лаборатория пишет только в ${labRoot()}/<id>`);
  }
  if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(`${dir}/${MARKER}`)) {
    throw new Error(`каталог «${dir}» существует, не пуст и не создан лабораторией (нет ${MARKER}) — не трогаю`);
  }
}

export function prepareDir(dir: string, id: string): { data: string; pgdata: string; cwd: string } {
  const sub = { data: `${dir}/data`, pgdata: `${dir}/pgdata`, cwd: `${dir}/cwd` };
  for (const p of Object.values(sub)) mkdirSync(p, { recursive: true });
  writeFileSync(`${dir}/${MARKER}`, id);
  return sub;
}

/**
 * Удалить каталог прогона, только если он несёт маркер. На Windows cwd и файлы PGlite отпускаются через ~секунду после
 * смерти процесса (встроенные повторы rmSync это не покрывают) — свой цикл с паузой. Не смогли → false, а не исключение:
 * остановка сервера от этого падать не должна.
 */
export async function removeRunDir(dir: string, attempts = 20, delayMs = 500): Promise<boolean> {
  if (!existsSync(`${dir}/${MARKER}`)) return false;
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

export function readMarker(dir: string): string | undefined {
  try {
    return readFileSync(`${dir}/${MARKER}`, "utf8");
  } catch {
    return undefined;
  }
}

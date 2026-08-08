/**
 * Базовый каталог данных Джарвиса (§универсальность — инсталлер работает на любой машине).
 *
 * Раньше каждый стор брал `join(process.cwd(), "data")` → данные оказывались относительно ТЕКУЩЕГО
 * рабочего каталога, что ломается при запуске из `C:\Program Files\…` (read-only), portable-режиме
 * или из чужого cwd. Единый резолвер: переменная `JARVIS_DATA_DIR` (инсталлер выставляет
 * `%APPDATA%/Jarvis`) → иначе ДЕФОЛТ `cwd/data` — то же, что было, поэтому существующие данные dev
 * НЕ теряются и поведение без env не меняется. Один путь на все сторы → инсталлер настраивает одним env.
 */
import { join } from "node:path";

/** Корневой каталог данных. JARVIS_DATA_DIR (инсталлер) → иначе cwd/data (dev, без потери данных). */
export function dataDir(): string {
  const env = process.env.JARVIS_DATA_DIR;
  return env && env.trim() ? env.trim() : join(process.cwd(), "data");
}

/** Путь внутри каталога данных: dataPath("memory") → <dataDir>/memory. */
export function dataPath(...parts: string[]): string {
  return join(dataDir(), ...parts);
}

/**
 * 🔴 ЛЕНИВЫЙ путь стора (найдено ЖИВЫМ прогоном, волна E): модули НЕЛЬЗЯ вычислять свои пути на
 * ВЕРХНЕМ УРОВНЕ (`const DATA_DIR = dataDir()`). ESM хойстит импорты ВЫШЕ `loadEnv()` в index.ts,
 * поэтому такой захват происходит ДО чтения `.env` — и `JARVIS_DATA_DIR`, положенный туда
 * инсталлером, оказывается МЁРТВОЙ настройкой: сторы молча уезжают в `cwd/data`. Для установки в
 * `C:\Program Files\…` (read-only cwd) это значит «Джарвис не сохранил ни профиль, ни память» —
 * причём тихо. Та же грабля, что с device эмбеддера и ленивой инициализацией ResendGuard.
 *
 * Значение считается ОДИН раз при первом обращении (после загрузки .env) и кешируется — путь стора
 * не должен «плавать» в рантайме. `resetLazyPathsForTests` сбрасывает кеш между тестами.
 */
export function lazyDataPath(...parts: string[]): () => string {
  let cached: string | undefined;
  const compute = (): string => {
    if (cached === undefined) cached = join(dataDir(), ...parts);
    return cached;
  };
  lazyResetters.push(() => {
    cached = undefined;
  });
  return compute;
}

const lazyResetters: Array<() => void> = [];

/** Тестам: забыть закешированные ленивые пути (после подмены JARVIS_DATA_DIR). */
export function resetLazyPathsForTests(): void {
  for (const r of lazyResetters) r();
}

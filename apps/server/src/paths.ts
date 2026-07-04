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

/**
 * Маркер «владелец сам закрыл Джарвиса» (2026-09-24). Хранитель клиента в супервизоре (infra/client-keeper.mjs)
 * перезапускает упавший клиент — но «Выйти» из трея это воля владельца, а не падение: с маркером хранитель
 * не поднимет клиент до следующего входа в Windows. Маркер снимается при каждом старте клиента.
 * Путь обязан совпадать с client-keeper.mjs: %APPDATA%/@jarvis/client/owner-quit.json (= userData клиента).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const OWNER_QUIT_FILE = "owner-quit.json";

export function markOwnerQuit(userDataDir: string): void {
  try {
    const p = join(userDataDir, OWNER_QUIT_FILE);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ at: Date.now() }), "utf8");
  } catch {
    /* без маркера хранитель увидит код 0 и тоже не станет воевать — это страховка, не единственный путь */
  }
}

export function clearOwnerQuit(userDataDir: string): void {
  try {
    rmSync(join(userDataDir, OWNER_QUIT_FILE), { force: true });
  } catch {
    /* не критично */
  }
}

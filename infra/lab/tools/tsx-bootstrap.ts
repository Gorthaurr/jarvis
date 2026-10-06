/**
 * Запуск CLI лаборатории под `node --import tsx` без флагов окружения: модули лаборатории и соседей тянут `@jarvis/*`
 * голым импортом, а tsx читает tsconfig только из cwd (в корне репозитория его нет). Регистрируем tsconfig лаборатории
 * (paths из tsconfig.base) ДО загрузки основного модуля — поэтому CLI = тонкий лаунчер + динамический import.
 */
import { register } from "tsx/esm/api";
import { fileURLToPath } from "node:url";

export function bootstrapTsx(): void {
  register({ tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)) });
}

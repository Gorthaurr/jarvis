import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Тесты ЛАБОРАТОРИИ (infra/lab). Лаборатория импортирует исходники сервера/клиента/пакетов относительными путями; их
 * собственные bare-импорты резолвятся от места самого файла. Алиасы @jarvis/* нужны только коду самой лаборатории.
 * Запуск: `node_modules/.bin/vitest run --root infra/lab` (из корня репозитория) или `pnpm lab:test`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@jarvis/protocol": at("../../packages/protocol/src/index.ts"),
      "@jarvis/shared": at("../../packages/shared/src/index.ts"),
      "@jarvis/tools": at("../../packages/tools/src/index.ts"),
      "@jarvis/userbots": at("../../packages/userbots/src/index.ts"),
    },
  },
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

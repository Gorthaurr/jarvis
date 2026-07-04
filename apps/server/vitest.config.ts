import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Гигиена данных (аудит 2026-07-02): изолированный JARVIS_DATA_DIR на прогон —
    // тесты не пишут в боевой apps/server/data (см. vitest.setup.ts).
    setupFiles: ["./vitest.setup.ts"],
  },
});

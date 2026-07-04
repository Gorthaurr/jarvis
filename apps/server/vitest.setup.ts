/**
 * Глобальный сетап vitest (гигиена данных, аудит 2026-07-02): тесты НЕ пишут в боевой
 * `apps/server/data`. Раньше `dataDir()` по умолчанию = cwd/data, и каждый прогон vitest
 * засорял ЖИВОЙ стор фикстурами (`learned__test-distillyacii-*`, «Полить кактус», тестовые
 * напоминания «Конец теста») — семантический recall потом матчил пользователя об этот мусор.
 *
 * Setup выполняется ДО импортов тест-файла (важно: часть модулей читает dataPath на module-load).
 * Тесты, которым нужен свой каталог (crypto/credentials), переопределяют env сами — это их право.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.JARVIS_DATA_DIR || !process.env.JARVIS_DATA_DIR.trim()) {
  process.env.JARVIS_DATA_DIR = mkdtempSync(join(tmpdir(), "jarvis-test-data-"));
}

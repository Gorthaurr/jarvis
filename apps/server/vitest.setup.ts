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

// Рефлекс-бэкстоп памяти (А3, 2026-07-10) в юнит-тестах ВЫКЛ: fire-and-forget LLM-вызов на реплике
// с маркером («я люблю…») молча съедал бы скриптованные ответы MockLlmProvider → флаки. Тесты самого
// рефлекса включают его локально (переопределить env — их право, как у crypto/credentials).
if (process.env.JARVIS_MEMORY_REFLECT === undefined) process.env.JARVIS_MEMORY_REFLECT = "0";

// Сон-цикл консолидации (Б1, 2026-07-11) в юнит-тестах ВЫКЛ по той же причине: фоновый LLM-вызов на
// первом коннекте нового дня жёг бы скриптованные ответы моков. Тест самого сон-цикла включает локально.
if (process.env.JARVIS_CONSOLIDATION === undefined) process.env.JARVIS_CONSOLIDATION = "0";

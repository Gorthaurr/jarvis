/**
 * Входные данные матрицы покрытия — простые структуры, собираемые из КОДА (sources-*.ts) или подставляемые тестами.
 * Идентификаторы строк — как в CoverageRow: `tool:<имя>` | `action:<kind>` | `intent:<kind>`.
 */
export type CoverLayer = "unit" | "integration";

/** Тестовый файл репозитория и какие из известных имён он упоминает по делу. */
export interface TestEvidence {
  /** Путь от корня репозитория (с /). */
  file: string;
  layer: CoverLayer;
  /** id строк матрицы (`tool:x`, `action:y`, `intent:z`), упомянутых этим файлом. */
  rows: string[];
}

export interface LiveOnlyEntry {
  /** id строки матрицы. */
  row: string;
  reason: string;
  /** Файл карты, откуда взято. */
  source: string;
}

export interface ScenarioCover {
  id: string;
  file: string;
  brain: "scripted" | "real" | "either";
  covers: string[];
  liveOnly?: string;
}

/** Кейс инструмента лаборатории, ЗАСЧИТАННЫЙ в покрытие (не пропущенный, а при --run — прошедший). */
export interface LabCaseCredit {
  id: string;
  rows: string[];
}

export interface CoverageSources {
  tools: string[];
  actions: string[];
  intents: string[];
  tests: TestEvidence[];
  liveOnly: LiveOnlyEntry[];
  scenarios: ScenarioCover[];
  labCases: LabCaseCredit[];
  /** Виды команд, что FakeDesktop умеет (для колонки «ПК» в отчёте). */
  fakeDesktopKinds: string[];
  /** Пояснения сборщика (проигнорированные файлы, несходящиеся списки). */
  warnings: string[];
}

export const toolRow = (n: string): string => `tool:${n}`;
export const actionRow = (k: string): string => `action:${k}`;
export const intentRow = (k: string): string => `intent:${k}`;

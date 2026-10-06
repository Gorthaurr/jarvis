/**
 * CLI матрицы покрытия:
 *   node --import tsx infra/lab/coverage/cli.ts [--write] [--out <файл>] [--json] [--no-run]
 * Без флагов печатает markdown в stdout. --write пишет docs/lab/COVERAGE.md. --no-run не прогоняет кейсы инструментов
 * (засчитает по статическому виду — быстрее, но не доказывает прохождение).
 * (лаунчер: регистрирует tsconfig лаборатории, затем грузит cli-main.ts).
 */
import { bootstrapTsx } from "../tools/tsx-bootstrap.js";

bootstrapTsx();
await import("./cli-main.js");

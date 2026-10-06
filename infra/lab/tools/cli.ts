/**
 * CLI раннера кейсов инструментов:
 *   node --import tsx infra/lab/tools/cli.ts [--json] [--filter <подстрока id>] [--tool <coversTool>]
 * (лаунчер: регистрирует tsconfig лаборатории, затем грузит cli-main.ts).
 */
import { bootstrapTsx } from "./tsx-bootstrap.js";

bootstrapTsx();
await import("./cli-main.js");

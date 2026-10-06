/**
 * CLI eval лаборатории (лаунчер: регистрирует tsconfig лаборатории, затем грузит cli-main.ts):
 *   node --import tsx infra/lab/eval/cli.ts [--brain off|real] [--n N] [--filter текст] [--tag тег] [--list] [--control] [--yes-spend]
 * Подробности и ограничения — cli-args.ts (USAGE). real без --yes-spend отказывает: это подписка владельца.
 */
import { bootstrapTsx } from "../tools/tsx-bootstrap.js";

bootstrapTsx();
await import("./cli-main.js");

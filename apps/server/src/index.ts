/**
 * Точка входа сервера Jarvis (§4).
 *
 * Грузит .env, создаёт логгер, конфигурирует БД (лениво), поднимает gateway,
 * вешает graceful shutdown на SIGINT/SIGTERM.
 */
import "dotenv/config";
import { createLogger } from "@jarvis/shared";
import { loadConfig } from "./config.js";
import { closeDb, configureDb } from "./db/pool.js";
import { createGateway } from "./gateway/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("server", config.logLevel);
  log.info("старт Jarvis server", {
    env: config.nodeEnv,
    protocol: config.protocolVersion,
    db: config.databaseUrl ? "configured" : "none (no-op)",
  });

  // Ленивая конфигурация БД — пул поднимется при первом запросе (§13).
  configureDb(config.databaseUrl);

  const gateway = createGateway(config, log);

  try {
    await gateway.listen();
  } catch (e) {
    log.error("не удалось поднять gateway", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // ── graceful shutdown ──────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("получен сигнал — завершаем", { signal });
    try {
      await gateway.close();
      await closeDb();
    } catch (e) {
      log.error("ошибка при остановке", e instanceof Error ? e.message : String(e));
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => {
    log.error("uncaughtException", e.message);
  });
  process.on("unhandledRejection", (e) => {
    log.error("unhandledRejection", e instanceof Error ? e.message : String(e));
  });
}

void main();

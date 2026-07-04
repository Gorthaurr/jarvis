/**
 * Точка входа сервера Jarvis (§4).
 *
 * Грузит .env, создаёт логгер, конфигурирует БД (лениво), поднимает gateway,
 * вешает graceful shutdown на SIGINT/SIGTERM.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createLogger } from "@jarvis/shared";
import { loadConfig } from "./config.js";
import { buildEnvCandidates, findEnvFile } from "./env-path.js";
import { closeDb, configureDb } from "./db/pool.js";
import { createGateway } from "./gateway/server.js";
import { warmupWhisper } from "./integrations/whisper-stt.js";

/**
 * Загрузить .env устойчиво к установке (§универсальность): JARVIS_ENV_PATH → %APPDATA%/Jarvis/.env →
 * cwd/.env → ../.env → module-relative (dev-монорепо). См. env-path.ts (тестируемо).
 */
function loadEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = buildEnvCandidates({ here });
  const found = findEnvFile(candidates, existsSync);
  // override: .env — источник истины для сервера, важнее унаследованного окружения
  // (напр. ANTHROPIC_BASE_URL родителя не должен перебивать прокси из .env).
  if (found) {
    dotenv.config({ path: found, override: true });
    return;
  }
  dotenv.config({ override: true });
}

async function main(): Promise<void> {
  loadEnv();
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

  // Прогрев Whisper на GPU сразу после старта (§10): первая фраза не ждёт загрузку
  // модели и upload на видеокарту. Первый запуск с новой моделью качает веса (~один раз).
  if (config.sttProvider === "whisper") warmupWhisper(config.whisperModel);

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

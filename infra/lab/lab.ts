/**
 * CLI лаборатории Джарвиса: `node --import tsx infra/lab/lab.ts <cmd>` (из корня репозитория).
 *   up [--brain off|real] [--stt mock|deepgram] [--port N]   поднять изолированный сервер, напечатать {id,port,dir,pid,token}
 *   down [id|all] [--keep]                                    погасить (только свои процессы), удалить каталог
 *   status                                                    что запущено и здорово ли
 *   say "<реплика>" [--confirm yes|no|expire|undelivered|a,b] [--seed файл.json] [--server id] [--timeout мс] [--wait-tasks] [--fresh]
 *   log [n] [--server id]      хвост логов          metrics [--server id]   строки metrics.jsonl
 * Боевой сервер на 8787 CLI не затрагивает: порт 8787 запрещён, убиваются только pid с меткой --lab-id.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

// @jarvis/* резолвятся алиасами tsconfig лаборатории; tsx берёт tsconfig из cwd, поэтому при первом запуске перезапускаем себя с нужным.
if (!process.env.TSX_TSCONFIG_PATH) {
  const r = spawnSync(process.execPath, ["--import", new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href, here("lab.ts"), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, TSX_TSCONFIG_PATH: here("tsconfig.json") },
  });
  process.exit(r.status ?? 1);
}

const { cmdDown, cmdLog, cmdMetrics, cmdStatus, cmdUp, parseArgs } = await import("./lib/server-cli.js");
const { cmdSay } = await import("./lib/client-cli.js");

const [cmd, ...rest] = process.argv.slice(2);
const print = (v: unknown): void => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

try {
  const a = parseArgs(rest);
  if (cmd === "up") print(await cmdUp(a));
  else if (cmd === "down") print(await cmdDown(a));
  else if (cmd === "status") print(await cmdStatus());
  else if (cmd === "say") print(await cmdSay(a));
  else if (cmd === "log") print(cmdLog(a));
  else if (cmd === "metrics") print(cmdMetrics(a));
  else {
    console.error("команды: up | down | status | say | log | metrics (см. шапку infra/lab/lab.ts)");
    process.exit(2);
  }
  process.exit(0); // detached-сервер и сокеты не должны держать CLI
} catch (e) {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
}

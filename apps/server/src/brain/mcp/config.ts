/**
 * Загрузка конфига MCP-серверов (§ арсенал). Формат `mcp.json` в корне репо или data/:
 * { "servers": { "<имя>": { "command": "npx", "args": ["-y","@scope/server"], "env": {"TOKEN":"${MY_TOKEN}"} } } }
 *
 * Секреты — только через `${ENV}` (файл в .gitignore). Windows: голый `npx` спавнится плохо из Node —
 * нормализуем в `npx.cmd` (через cmd.exe), иначе ENOENT.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("mcp:config");

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

const EMPTY: McpConfig = { servers: {} };

/** Подставить ${ENV} из process.env (для токенов). Нет переменной → пустая строка + варн. */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) log.warn("MCP config: ENV не задан", { name });
    return v ?? "";
  });
}

/**
 * Windows: голые `npx`/`npm`/`node`/`uvx`/`uv` через Node-spawn (без shell) часто ENOENT — Node не
 * применяет PATHEXT, нужно точное имя с расширением. npm-обёртки = `.cmd` (батники), uv-бинари = `.exe`.
 * Прочие команды (полный путь, python и т.п.) не трогаем. Экспортируется для юнит-теста.
 */
export function normalizeCommand(cmd: string): { command: string; viaShell: boolean } {
  if (process.platform === "win32") {
    if (/^(npx|npm|node)$/i.test(cmd)) {
      return { command: cmd.toLowerCase().endsWith(".cmd") ? cmd : `${cmd}.cmd`, viaShell: false };
    }
    if (/^(uvx|uv)$/i.test(cmd)) {
      return { command: cmd.toLowerCase().endsWith(".exe") ? cmd : `${cmd}.exe`, viaShell: false };
    }
  }
  return { command: cmd, viaShell: false };
}

/** Прочитать mcp.json (корень репо / data/). Нет файла/битый → пустой конфиг (арсенал просто пуст). */
export function loadMcpConfig(): McpConfig {
  const candidates = [
    join(process.cwd(), "mcp.json"),
    join(process.cwd(), "..", "..", "mcp.json"),
    join(process.cwd(), "data", "mcp.json"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return EMPTY;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as McpConfig;
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, sc] of Object.entries(raw.servers ?? {})) {
      if (!sc || typeof sc.command !== "string") continue;
      const norm = normalizeCommand(sc.command);
      servers[name] = {
        command: norm.command,
        args: (sc.args ?? []).map(resolveEnvVars),
        env: Object.fromEntries(Object.entries(sc.env ?? {}).map(([k, v]) => [k, resolveEnvVars(String(v))])),
      };
    }
    log.info("MCP config загружен", { path, серверов: Object.keys(servers).length });
    return { servers };
  } catch (e) {
    log.warn("MCP config: не удалось прочитать — игнорирую", { path, error: e instanceof Error ? e.message : String(e) });
    return EMPTY;
  }
}

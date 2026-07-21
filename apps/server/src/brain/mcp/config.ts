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
  /** stdio-транспорт: команда запуска ЛОКАЛЬНОГО сервера (npx/uvx/путь). Для HTTP-сервера не нужна. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP-транспорт (удалённый/SaaS MCP, ревью learn-coding-agent 2026-07-15): URL эндпоинта. Задан →
   *  StreamableHTTP вместо stdio. SDK уже везёт транспорт; секреты — статическим Bearer в headers (без OAuth). */
  url?: string;
  /** Заголовки HTTP-транспорта (напр. { "Authorization": "Bearer ${MY_TOKEN}" }); ${ENV} резолвится. */
  headers?: Record<string, string>;
  /**
   * §14 CONFIRM для МУТИРУЮЩИХ MCP-инструментов (глобальный план 2026-07-21, «MCP-контракт»): раньше MCP-ветка
   * dispatch минула confirm-гейт → сторонний create/delete/send-MCP исполнялся бы БЕЗ подтверждения. Декларация
   * владельцем: `true` = ВСЕ инструменты сервера требуют confirm; массив bare-имён = конкретные. По умолчанию
   * (нет поля) — без confirm (read-only/доверенные серверы; привилегированное всё равно первопартийное).
   */
  confirm?: boolean | string[];
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
 * Windows: голые `npx`/`npm`/`uvx`/`uv` через Node-spawn (без shell) часто ENOENT — Node не
 * применяет PATHEXT, нужно точное имя с расширением. npm-обёртки = `.cmd` (батники), uv-бинари = `.exe`.
 * `node` НЕ трогаем — это `node.exe`, а не батник; мапить в `node.cmd` значило бы спавнить
 * несуществующий файл (ENOENT наоборот). Прочие команды (полный путь, python и т.п.) не трогаем.
 * Экспортируется для юнит-теста.
 */
export function normalizeCommand(cmd: string): { command: string; viaShell: boolean } {
  if (process.platform === "win32") {
    if (/^(npx|npm)$/i.test(cmd)) {
      return { command: cmd.toLowerCase().endsWith(".cmd") ? cmd : `${cmd}.cmd`, viaShell: false };
    }
    if (/^(uvx|uv)$/i.test(cmd)) {
      return { command: cmd.toLowerCase().endsWith(".exe") ? cmd : `${cmd}.exe`, viaShell: false };
    }
  }
  return { command: cmd, viaShell: false };
}

/**
 * Чистая нормализация сырого конфига (SRP: без файлового IO — тестируется напрямую). Каждый сервер —
 * либо HTTP (url), либо stdio (command); ${ENV} резолвится в url/args/env/headers.
 */
/** Нормализация §14-confirm: `true` (все) или массив bare-имён; иначе поля нет. Ревью: один не-строковый
 *  элемент раньше (`.every`) ронял ВСЮ декларацию (fail-OPEN — задекларированный delete исполнялся бы без
 *  confirm при опечатке). Теперь `.filter` СОХРАНЯЕТ валидные имена + WARN об отбросе мусора. */
function parseConfirm(c: unknown): { confirm?: boolean | string[] } {
  if (c === true) return { confirm: true };
  if (Array.isArray(c)) {
    const strs = c.filter((x): x is string => typeof x === "string");
    if (strs.length < c.length) {
      log.warn("MCP config: не-строковые элементы в confirm отброшены (валидные имена сохранены)", { dropped: c.length - strs.length });
    }
    return strs.length > 0 ? { confirm: strs } : {};
  }
  return {};
}

export function parseMcpConfig(raw: McpConfig): McpConfig {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, sc] of Object.entries(raw?.servers ?? {})) {
    if (!sc) continue;
    // HTTP-транспорт (удалённый MCP): url задан → берём его, command игнорируем. Только http(s) (не file:/
    // прочие схемы — конфиг владельческий, но защищаемся от опечатки). Секреты в headers через ${ENV}.
    if (typeof sc.url === "string" && sc.url.trim()) {
      const url = resolveEnvVars(sc.url.trim());
      if (!/^https?:\/\//i.test(url)) {
        log.warn("MCP config: url должен быть http(s) — сервер пропущен", { name });
        continue;
      }
      servers[name] = {
        url,
        headers: Object.fromEntries(Object.entries(sc.headers ?? {}).map(([k, v]) => [k, resolveEnvVars(String(v))])),
        ...parseConfirm(sc.confirm),
      };
      continue;
    }
    if (typeof sc.command !== "string") continue;
    const norm = normalizeCommand(sc.command);
    servers[name] = {
      command: norm.command,
      args: (sc.args ?? []).map(resolveEnvVars),
      env: Object.fromEntries(Object.entries(sc.env ?? {}).map(([k, v]) => [k, resolveEnvVars(String(v))])),
      ...parseConfirm(sc.confirm),
    };
  }
  return { servers };
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
    const parsed = parseMcpConfig(raw);
    log.info("MCP config загружен", { path, серверов: Object.keys(parsed.servers).length });
    return parsed;
  } catch (e) {
    log.warn("MCP config: не удалось прочитать — игнорирую", { path, error: e instanceof Error ? e.message : String(e) });
    return EMPTY;
  }
}

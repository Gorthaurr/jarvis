/**
 * §Волна3 (3.4) — Generic GSI-листенер: локальный HTTP-приёмник JSON-пушей от программ/игр.
 *
 * Принцип персоны v21 «API программы прежде GUI» применительно к играм: Dota 2 (Game State
 * Integration), OBS-скрипты, любые локальные тулзы могут ПУШИТЬ своё состояние на
 * http://127.0.0.1:<порт>/<source> — и Джарвис наблюдает его за $0 (условие wait_for/watch
 * kind:"gsi"), вместо поллинга скриншотами. НЕ хардкод игры: листенер source-агностичен,
 * конфиг конкретной игры (gamestate_integration_*.cfg) пишет сам Джарвис через fs_write по просьбе.
 *
 * Безопасность: слушаем ТОЛЬКО 127.0.0.1 (пуш локальных процессов), тело ≤256KB, содержимое —
 * ДАННЫЕ (сервер оборачивает выдачу условий в untrusted; сырой JSON в промпт не уходит).
 * Выключатель: JARVIS_GSI_PORT=0; дефолтный порт 3730.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { createLogger } from "@jarvis/shared";

const log = createLogger("sensors:gsi");

interface GsiEntry {
  data: unknown;
  at: number;
}

/** Последний пуш на каждый source (путь URL без слешей). */
const state = new Map<string, GsiEntry>();
let server: Server | null = null;

const MAX_BODY_BYTES = 256 * 1024;
/** Свежесть состояния: старше — считаем, что источник замолчал (игра закрыта), данных нет. */
const STALE_MS = 20_000;

function port(): number {
  const n = Number.parseInt(process.env.JARVIS_GSI_PORT ?? "", 10);
  if (Number.isFinite(n)) return n; // 0 = выключено
  return 3730;
}

/** Поднять листенер (идемпотентно). Порт занят/ошибка → честный warn, сенсор недоступен. */
export function startGsiListener(): void {
  const p = port();
  if (p <= 0 || server) return;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const source = (req.url ?? "/").replace(/^\/+|\/+$/g, "").toLowerCase() || "default";
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy(); // анти-DoS: не копим мегабайты
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        state.set(source, { data, at: Date.now() });
        res.writeHead(200).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    req.on("error", () => res.writeHead(400).end());
  });
  server.on("error", (e) => {
    log.warn(`GSI-листенер не поднялся (${e.message}) — условия kind:"gsi" недоступны`);
    server = null;
  });
  server.listen(p, "127.0.0.1", () => log.info("GSI-листенер слушает", { port: p }));
  server.unref?.();
}

export function stopGsiListener(): void {
  server?.close();
  server = null;
}

/** Достать значение по точечному пути («map.game_state») из последнего пуша source. */
export function gsiValue(source: string | undefined, path: string): { fresh: boolean; value: unknown } | null {
  const entry = state.get((source ?? "default").toLowerCase()) ?? (source === undefined && state.size === 1 ? [...state.values()][0] : undefined);
  if (!entry) return null;
  let cur: unknown = entry.data;
  for (const key of path.split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return { fresh: Date.now() - entry.at < STALE_MS, value: undefined };
    cur = (cur as Record<string, unknown>)[key];
  }
  return { fresh: Date.now() - entry.at < STALE_MS, value: cur };
}

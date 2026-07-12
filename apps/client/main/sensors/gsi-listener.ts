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
/**
 * Свежесть состояния: старше — считаем, что источник замолчал (игра закрыта), данных нет.
 * §Волна3 ревью (#11): 45с > канонический GSI-heartbeat Dota (30с) — при неизменном состоянии источник
 * шлёт лишь heartbeat, и слишком короткое окно давало ложные «протухли» → дребезг озвучки. Env-настройка.
 */
const STALE_MS = (() => {
  const n = Number.parseInt(process.env.JARVIS_GSI_STALE_MS ?? "", 10);
  return Number.isFinite(n) && n >= 5_000 && n <= 600_000 ? n : 45_000;
})();
/**
 * Ревью фиксов Волны 3 (#3): окно «недавнего исчезновения». Стор без TTL хранит запись прошлой сессии
 * часами — для gone-условий протухание старше этого окна считается «давно мёртв» (эквивалент «никогда
 * не пушил»), а НЕ «только что исчез»: иначе watch «скажи когда матч закончится», поставленный после
 * закрытия игры, давал ложный met на первом же опросе.
 */
const GONE_WINDOW_MS = STALE_MS * 4;
/** §Волна3 ревью (#10): кап числа источников — CSRF/сбойная тулза не должна плодить вечные записи (OOM). */
const MAX_SOURCES = 32;
/** §Волна3 ревью (#9): опц. токен (конвенция Valve GSI: тело.auth.token). Задан → пуш без него отвергаем.
 *  Читается per-request (ревью фиксов #5): env-переключение видно без рестарта, и гард тестируем. */
function gsiToken(): string {
  return (process.env.JARVIS_GSI_TOKEN ?? "").trim();
}
/** Хосты, разрешённые в заголовке Host — анти-DNS-rebinding (браузер с чужого домена, срезолвленного в 127.0.0.1). */
const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function port(): number {
  const n = Number.parseInt(process.env.JARVIS_GSI_PORT ?? "", 10);
  if (Number.isFinite(n)) return n; // 0 = выключено
  return 3730;
}

/** §Волна3 ревью (#10): положить запись с вытеснением старейшей при переполнении капа источников. */
function putState(source: string, data: unknown): void {
  if (!state.has(source) && state.size >= MAX_SOURCES) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [k, v] of state) if (v.at < oldestAt) ((oldestAt = v.at), (oldestKey = k));
    if (oldestKey !== undefined) state.delete(oldestKey);
  }
  state.set(source, { data, at: Date.now() });
}

/** Поднять листенер (идемпотентно). Порт занят/ошибка → честный warn, сенсор недоступен. */
export function startGsiListener(): void {
  const p = port();
  if (p <= 0 || server) return;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.writeHead(405).end(); // GET/OPTIONS(preflight) — без CORS-заголовков → браузерный preflight падает
      return;
    }
    // §Волна3 ревью (#9) БЕЗОПАСНОСТЬ (листенер включён по умолчанию):
    //  (1) Origin присутствует → это браузерный fetch (локальные тулзы/Valve GSI Origin НЕ шлют) → CSRF, отказ.
    //  (2) Host не 127.0.0.1/localhost → DNS-rebinding (браузер по срезолвленному в loopback домену) → отказ.
    //  (3) Content-Type обязан быть application/json — «простой» кросс-доменный POST его выставить не может
    //      (иначе preflight, который мы валим п.1). Valve GSI шлёт именно application/json.
    if (req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    const host = String(req.headers.host ?? "");
    if (host && !HOST_OK.test(host)) {
      res.writeHead(403).end();
      return;
    }
    const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!ctype.includes("application/json")) {
      res.writeHead(415).end();
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
        // §Волна3 ревью (#9): опц. токен — конвенция Valve GSI (тело.auth.token). Задан env → сверяем.
        const expected = gsiToken();
        if (expected) {
          const tok = (data as { auth?: { token?: unknown } } | null)?.auth?.token;
          if (tok !== expected) {
            res.writeHead(401).end();
            return;
          }
        }
        // Ревью фиксов Волны 3 (#4): секрет auth.token в стор НЕ кладём (сверка выше уже состоялась) —
        // иначе он читаем через wait_for{path:"auth.token"} и утекал бы в tool_result/контекст/логи,
        // обесценивая гард. Срезаем безусловно: игра может слать токен и без нашего env.
        if (data && typeof data === "object" && !Array.isArray(data) && "auth" in data) {
          delete (data as Record<string, unknown>).auth;
        }
        putState(source, data);
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

/**
 * Достать значение по точечному пути («map.game_state») из последнего пуша source.
 * recentlyGone (ревью фиксов #3): протух, но НЕДАВНО (внутри GONE_WINDOW_MS) — только такое протухание
 * законно считать «источник только что исчез»; более старая запись для gone-условий = «нет данных».
 */
export function gsiValue(
  source: string | undefined,
  path: string,
): { fresh: boolean; recentlyGone: boolean; value: unknown } | null {
  const entry = state.get((source ?? "default").toLowerCase()) ?? (source === undefined && state.size === 1 ? [...state.values()][0] : undefined);
  if (!entry) return null;
  const ageMs = Date.now() - entry.at;
  const fresh = ageMs < STALE_MS;
  const recentlyGone = !fresh && ageMs < GONE_WINDOW_MS;
  let cur: unknown = entry.data;
  for (const key of path.split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return { fresh, recentlyGone, value: undefined };
    cur = (cur as Record<string, unknown>)[key];
  }
  return { fresh, recentlyGone, value: cur };
}

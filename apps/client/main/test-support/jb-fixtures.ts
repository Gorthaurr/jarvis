/**
 * W4 (B-14/B-2): стенд НАСТОЯЩЕГО невидимого браузера Джарвиса — `JarvisBrowser` поднимает настоящий Chromium
 * (DI-опции конструктора: путь, флаги headless/no-sandbox, профиль во временной папке), фикстуры — два HTTP-сервера:
 * «публичный» сайт под именем `shop.jb.example` (host-resolver → 127.0.0.1) и «внутренняя сеть» на 127.0.0.1.
 * Факты тестов — по ЖУРНАЛУ запросов фикстур (дошёл ли запрос до «роутера», сколько раз POST ушёл на сервер).
 *
 * B-14 (DNS): «DNS» стенда — таблица `fixtureLookup`: shop — публичный TEST-NET адрес, evil — 127.0.0.1
 * (localtest.me-класс), mixed — публичный + 127.0.0.1, slow — 127.0.0.1 с задержкой, rebind* — первый ответ публичный,
 * дальше 127.0.0.1 (DNS rebinding, TTL 0), прочие `*.jb.example` — не разрешаются. По ней судят И гард навигации, И
 * прокси пиннинга (через него Chrome ходит всегда); прокси звонит на проверенный адрес, TEST-NET подменяется на
 * 127.0.0.1 (`fixtureMapAddress`). `--host-resolver-rules` оставлен НАРОЧНО: Chrome, обошедший прокси (сломанный
 * пиннинг), сам уведёт `*.jb.example` на 127.0.0.1 — и «роутер» увидит запрос, тест покраснеет.
 *
 * Подключение: vi.mock("electron", ...) в тест-файле (offscreenPos читает screen).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostLookup, systemLookup } from "@jarvis/shared";
import { chromeCandidates } from "../actuators/browser-cdp.js";
import { JarvisBrowser } from "../actuators/jarvis-browser.js";

export const PUBLIC_HOST = "shop.jb.example";
const TEST_NET = "203.0.113.10";
/** Публичный ответ rebind*-имён: «сайт атакующего», которого на стенде нет (127.0.0.2 — никто не слушает). */
const REBIND_PUBLIC = "203.0.113.66";

const FIXTURE_DNS: Record<string, string[]> = {
  [PUBLIC_HOST]: [TEST_NET],
  "evil.jb.example": ["127.0.0.1"],
  "mixed.jb.example": [TEST_NET, "127.0.0.1"],
};
/** Сколько раз спрашивали rebind*-имя (первый ответ — публичный, дальше — 127.0.0.1). */
export const rebindAsked = new Map<string, number>();

/** «DNS» стенда для гарда навигации: имена фикстур — по таблице, остальное — настоящий DNS (живые тесты). */
export const fixtureLookup: HostLookup = async (host) => {
  if (host === "slow.jb.example") return new Promise((r) => setTimeout(() => r(["127.0.0.1"]), 1500));
  if (/^rebind[\w-]*\.jb\.example$/u.test(host)) {
    const n = (rebindAsked.get(host) ?? 0) + 1;
    rebindAsked.set(host, n);
    return n === 1 ? [REBIND_PUBLIC] : ["127.0.0.1"];
  }
  const v = FIXTURE_DNS[host];
  if (v) return v;
  if (host.endsWith(".jb.example")) throw Object.assign(new Error(`нет ${host}`), { code: "ENOTFOUND" });
  return systemLookup(host);
};

/** Chrome/Chromium для стенда: CHROME_PATH, облачный Chromium, иначе установленный Chrome владельца. */
export function findChrome(): string | null {
  const c = [process.env.CHROME_PATH, "/opt/pw-browsers/chromium", ...chromeCandidates()].filter((p): p is string => Boolean(p));
  return c.find((p) => existsSync(p)) ?? null;
}

export interface Hit {
  method: string;
  url: string;
  body: string;
}

export interface Fixture {
  port: number;
  hits: Hit[];
  close(): Promise<void>;
}

type Route = (req: IncomingMessage, body: string, res: ServerResponse, port: number) => void;

/** HTTP-фикстура с журналом запросов. routes: путь → обработчик; нет пути → 404. */
export async function fixture(routes: Record<string, Route | string>): Promise<Fixture> {
  const hits: Hit[] = [];
  let port = 0;
  const srv: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0]!;
      if (path === "/favicon.ico") return void res.writeHead(404).end();
      hits.push({ method: req.method ?? "GET", url: req.url ?? "/", body });
      const r = routes[path];
      if (r === undefined) return void res.writeHead(404).end("нет");
      if (typeof r === "string") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return void res.end(r.replace(/\{\{PORT\}\}/gu, String(port)));
      }
      r(req, body, res, port);
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const a = srv.address();
  port = typeof a === "object" && a ? a.port : 0;
  return { port, hits, close: () => new Promise((r) => srv.close(() => r())) };
}

/** Прокси пиннинга звонит на проверенный адрес: «публичный» TEST-NET фикстур живёт на 127.0.0.1. Суд — ДО подмены. */
export const fixtureMapAddress = (ip: string): string => (ip === TEST_NET ? "127.0.0.1" : ip === REBIND_PUBLIC ? "127.0.0.2" : ip);

/** Настоящий JarvisBrowser на Chromium стенда (временный профиль; DNS гарда и прокси — fixtureLookup; обход прокси → host-resolver). */
export function launchJarvisBrowser(chrome: string, opts: { noPreconnect?: boolean } = {}): { jb: JarvisBrowser; dispose(): Promise<void> } {
  const profile = mkdtempSync(join(tmpdir(), "jarvis-jb-"));
  if (opts.noPreconnect) {
    // Предподключение Chrome (навигация, нажатие на ссылку) идёт МИМО Fetch-перехвата и раньше него: порядок «гард →
    // прокси» плавает. Без него он детерминирован — rebinding-тест доказывает именно суд прокси при подключении.
    mkdirSync(join(profile, "Default"), { recursive: true });
    writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ net: { network_prediction_options: 2 } }));
  }
  const rootOnly = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  const jb = new JarvisBrowser({
    chromePath: chrome,
    profileDir: profile,
    startUrl: "about:blank",
    settleMs: 200,
    resolveHost: fixtureLookup,
    mapAddress: fixtureMapAddress,
    extraArgs: [...rootOnly, "--headless=new", "--disable-gpu", "--host-resolver-rules=MAP *.jb.example 127.0.0.1"],
  });
  return {
    jb,
    dispose: async () => {
      await jb.close();
      await new Promise((r) => setTimeout(r, 200));
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Chrome ещё держит файлы — временная папка */
      }
    },
  };
}

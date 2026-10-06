/**
 * HTTP-сервер фикстур: loopback, эфемерный порт. Браузер лаборатории ходит на него по ИМЕНАМ хостов
 * (`--host-resolver-rules` -> 127.0.0.1:<порт>): §14 и SSRF судят по имени, а loopback-адрес сервер Джарвиса блокирует.
 * Журнал: каждое событие страницы (`/__event`) и каждый запрос страницы — проверка по факту, а не по словам инструмента.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CHECKOUT, DYNAMIC, FRAME, FRAME_INNER, HANG, ITEMS_PAGE_2, LOGIN } from "./fixture-pages-app.js";
import { ARTICLE, INDEX, INJECTION } from "./fixture-pages.js";
import { LAB_SCRIPT } from "./fixture-script.js";

export interface FixtureEvent {
  n: number;
  at: number;
  /** pay | details_shown | login_submit | ... — что случилось В СТРАНИЦЕ. */
  kind: string;
  page: string;
  host: string;
  detail: Record<string, unknown>;
}

export interface FixtureHit {
  path: string;
  host: string;
  status: number;
}

export interface FixtureServer {
  port: number;
  events(kind?: string): FixtureEvent[];
  hits(): FixtureHit[];
  reset(): void;
  close(): Promise<void>;
}

const HTML: Record<string, string> = {
  "/": INDEX, "/login": LOGIN, "/checkout": CHECKOUT, "/article": ARTICLE, "/injection": INJECTION, "/frame": FRAME, "/frame-inner": FRAME_INNER, "/dynamic": DYNAMIC, "/hang": HANG,
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });

export async function startFixtures(): Promise<FixtureServer> {
  const events: FixtureEvent[] = [];
  const hits: FixtureHit[] = [];
  const send = (res: ServerResponse, status: number, type: string, body: string): void => {
    res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
    res.end(body);
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fixture.invalid");
      const host = String(req.headers.host ?? "").replace(/:\d+$/u, "");
      if (req.method === "POST" && url.pathname === "/__event") {
        const j = safeJson(await readBody(req));
        events.push({ n: events.length + 1, at: Date.now(), kind: String(j.kind ?? "?"), page: String(j.page ?? ""), host, detail: (j.detail as Record<string, unknown>) ?? {} });
        return send(res, 204, "text/plain", "");
      }
      if (url.pathname === "/__events") return send(res, 200, "application/json", JSON.stringify(events));
      const route = url.pathname === "/__lab.js" ? { type: "text/javascript", body: LAB_SCRIPT } : url.pathname === "/api/items" ? { type: "application/json", body: JSON.stringify(ITEMS_PAGE_2) } : HTML[url.pathname] ? { type: "text/html", body: HTML[url.pathname] as string } : null;
      hits.push({ path: url.pathname, host, status: route ? 200 : 404 });
      route ? send(res, 200, route.type, route.body) : send(res, 404, "text/plain", "нет такой страницы стенда");
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve); // только loopback: извне стенд недостижим
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    events: (kind) => (kind ? events.filter((e) => e.kind === kind) : [...events]),
    hits: () => [...hits],
    reset() {
      events.length = 0;
      hits.length = 0;
    },
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const j = JSON.parse(s) as unknown;
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

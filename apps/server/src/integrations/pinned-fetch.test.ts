/**
 * B-14 (DNS): web.fetch НАСТОЯЩИМИ сокетами. «Роутер» — HTTP-сервер на 127.0.0.1 с журналом; имя, которое резолвер
 * отдаёт как 127.0.0.1, обязано НЕ дойти до него ни одним запросом. Факт — по журналу сервера, не по ответу.
 *
 * Реверт-проверки (из копии): pinnedLookup отдаёт адреса без суда → «роутер» получает запрос → красный;
 * WebProvider по умолчанию снова на глобальном fetch → живой localtest.me доходит до «роутера» → красный; общее правило
 * без своих сетей ПК (`local-nets.ts`) или pinnedLookup без `interfaces` → «свой интерфейс» красный (живой — на ПК с Radmin).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, get, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { type HostLookup, isPrivateIp } from "@jarvis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRIVATE_ADDRESS, pinnedLookup, pinnedTransport, toResponse } from "./pinned-fetch.js";
import { WebProvider } from "./web.js";

let server: Server;
let port = 0;
const hits: string[] = [];
let hangClosedAt = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "/");
    if (req.url === "/gz") return void res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "gzip" }).end(gzipSync("разжатое тело"));
    if (req.url === "/empty") return void res.writeHead(204).end();
    if (req.url === "/gzbr") return void res.writeHead(200, { "content-encoding": "gzip, br" }).end(brotliCompressSync(gzipSync("два слоя сжатия")));
    if (req.url === "/zstd") return void res.writeHead(200, { "content-encoding": "zstd" }).end("(µ/ý сырые байты");
    if (req.url === "/gz-hang") {
      req.socket.on("close", () => void (hangClosedAt = Date.now()));
      return void res.writeHead(200, { "content-encoding": "gzip" }).write(gzipSync("x".repeat(50_000)).subarray(0, 200)); // тело не кончается
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h1>ROUTER-SECRET</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  port = typeof a === "object" && a ? a.port : 0;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Резолвер-таблица со счётчиком вызовов. */
function table(map: Record<string, string[]>): HostLookup & { calls: number } {
  const fn = Object.assign(
    async (host: string) => {
      fn.calls += 1;
      const v = map[host];
      if (!v) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
      return v;
    },
    { calls: 0 },
  );
  return fn;
}
const signal = () => AbortSignal.timeout(3000);

describe("B-14 (DNS): транспорт web.fetch пиннит проверенный адрес", () => {
  it("имя → 127.0.0.1: отказ в lookup сокета, «роутер» не получил НИ ОДНОГО запроса, резолв ровно один", async () => {
    hits.length = 0;
    const lookup = table({ "pinned.example": ["127.0.0.1"] });
    const err = await pinnedTransport(lookup)(`http://pinned.example:${port}/secret`, { headers: {}, signal: signal() }).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(err?.code).toBe(PRIVATE_ADDRESS);
    expect(hits).toEqual([]);
    expect(lookup.calls).toBe(1); // суд — ВНУТРИ подключения, отдельного (второго) резолва нет
  });

  it("https (основной трафик web.fetch): тот же суд в lookup TLS-сокета — отказ PRIVATE_ADDRESS, TCP-соединений нет", async () => {
    let connections = 0;
    const count = () => void (connections += 1);
    server.on("connection", count);
    const lookup = table({ "pinned.example": ["127.0.0.1"] });
    try {
      const err = await pinnedTransport(lookup)(`https://pinned.example:${port}/`, { headers: {}, signal: signal() }).then(
        () => null,
        (e: NodeJS.ErrnoException) => e,
      );
      expect(err?.code).toBe(PRIVATE_ADDRESS); // не TLS-ошибка: до tls.connect дело не дошло
      expect(lookup.calls).toBe(1);
      expect(connections).toBe(0);
    } finally {
      server.off("connection", count);
    }
  });

  it("мультизапись «публичный + 127.0.0.1» → отказ, запросов нет", async () => {
    hits.length = 0;
    const lookup = table({ "mixed.example": ["203.0.113.10", "127.0.0.1"] });
    await expect(pinnedTransport(lookup)(`http://mixed.example:${port}/`, { headers: {}, signal: signal() })).rejects.toMatchObject({ code: PRIVATE_ADDRESS });
    expect(hits).toEqual([]);
  });

  it("имя → адрес соседа по сети своего интерфейса (Radmin VPN) → PRIVATE_ADDRESS, подключения нет", async () => {
    hits.length = 0;
    // В роли 26.106.17.249/8 — TEST-NET-2: его нет у настоящих интерфейсов, суд обязан взять список из `interfaces`.
    const interfaces = () => ({ "Radmin VPN": [{ address: "198.51.100.7", cidr: "198.51.100.7/24" }] });
    const lookup = table({ "radmin.example": ["198.51.100.200"] });
    await expect(pinnedTransport(lookup, interfaces)(`http://radmin.example:${port}/`, { headers: {}, signal: signal() })).rejects.toMatchObject({ code: PRIVATE_ADDRESS });
    expect(lookup.calls).toBe(1);
    expect(hits).toEqual([]);
  });

  it("WebProvider.fetch поверх транспорта: имя, указывающее внутрь → честный null, запросов нет", async () => {
    hits.length = 0;
    const web = new WebProvider(undefined, pinnedTransport(table({ "pinned.example": ["127.0.0.1"] })));
    expect(await web.fetch(`http://pinned.example:${port}/secret`)).toBeNull();
    expect(hits).toEqual([]);
  });

  it("lookup отдаёт сокету ТОЛЬКО проверенные адреса (all / одиночный / по семейству)", async () => {
    const look = pinnedLookup(table({ "pub.example": ["203.0.113.10", "2001:db8::7"] }));
    const call = (opts: object) => new Promise<unknown[]>((r) => look("pub.example", opts, (...args) => r(args)));
    expect(await call({ all: true })).toEqual([null, [{ address: "203.0.113.10", family: 4 }, { address: "2001:db8::7", family: 6 }]]);
    expect(await call({})).toEqual([null, "203.0.113.10", 4]);
    expect(await call({ all: true, family: 6 })).toEqual([null, [{ address: "2001:db8::7", family: 6 }]]);
    expect(await call({ all: true, family: "IPv4" })).toEqual([null, [{ address: "203.0.113.10", family: 4 }]]);
    const [e] = await new Promise<unknown[]>((r) => pinnedLookup(table({}))("nx.example", {}, (...args) => r(args)));
    expect((e as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });

  it("механика ответа как у fetch: gzip разжат (без content-encoding), 204 — без тела", async () => {
    const raw = (path: string) => new Promise<import("node:http").IncomingMessage>((r) => get(`http://127.0.0.1:${port}${path}`, r));
    const gz = toResponse(await raw("/gz"));
    expect(gz.headers.get("content-encoding")).toBeNull();
    expect(await gz.text()).toBe("разжатое тело");
    const empty = toResponse(await raw("/empty"));
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
    // Адверс-ревью: «gzip, br» раньше уходил модели сжатыми байтами; неизвестное сжатие — честный отказ, не мусор.
    expect(await toResponse(await raw("/gzbr")).text()).toBe("два слоя сжатия");
    const zstd = await raw("/zstd");
    expect(() => toResponse(zstd)).toThrow(/неизвестное сжатие/u);
  });

  it("отмена тела на пути разжатия закрывает и сокет (раньше висел до таймаута цепочки)", async () => {
    hangClosedAt = 0;
    const res = await new Promise<import("node:http").IncomingMessage>((r) => get(`http://127.0.0.1:${port}/gz-hang`, r));
    const t0 = Date.now();
    await toResponse(res).body!.cancel();
    await new Promise((r) => setTimeout(r, 500));
    expect(hangClosedAt).toBeGreaterThanOrEqual(t0);
  });
});

// Живой факт 27.09 ровно в той форме, в какой он был: настоящий публичный DNS (localtest.me → 127.0.0.1) и web.fetch
// по умолчанию. Без сети/если имя перестало указывать на loopback — пропуск (факт проверить нечем).
const liveLoopbackName = await dnsLookup("localtest.me").then((a) => a.address === "127.0.0.1", () => false);

describe("WebProvider.fetch: не-2xx — тело отменяется сразу (сокет не висит до таймаута цепочки)", () => {
  it("404 → null и cancel() тела", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: () => void (cancelled = true) });
    const web = new WebProvider(undefined, async () => new Response(body, { status: 404 }));
    expect(await web.fetch("https://pub.example/missing")).toBeNull();
    expect(cancelled).toBe(true);
  });
});

describe.skipIf(!liveLoopbackName)("B-14 (DNS) живьём: web.fetch по умолчанию", () => {
  it("http://localtest.me:<порт>/ → null, «роутер» на 127.0.0.1 запросов не получил", async () => {
    hits.length = 0;
    expect(await new WebProvider(undefined).fetch(`http://localtest.me:${port}/secret`)).toBeNull();
    expect(hits).toEqual([]);
  });
});

// Живой факт адверс-ревью 27.09: «роутер» на 0.0.0.0 (как PostgreSQL 5432), НАСТОЯЩИЙ адрес интерфейса этого ПК вне
// RFC1918 (на ПК владельца — Radmin VPN 26.106.17.249), системный список интерфейсов. Имя → такой адрес идёт через
// lookup сокета; литерал Node в lookup НЕ передаёт — его судит isFetchUrlAllowed. Нет такого адреса — пропуск.
const ownOutsideRanges = Object.values(networkInterfaces())
  .flatMap((l) => l ?? [])
  .filter((a) => a.family === "IPv4" && !isPrivateIp(a.address, () => ({})))
  .map((a) => a.address);

describe.skipIf(!ownOutsideRanges.length)("B-14 живьём: свой адрес ПК вне RFC1918, «роутер» на 0.0.0.0", () => {
  it("имя → свой адрес и литерал своего адреса в url → null, «роутер» запросов не получил", async () => {
    const got: string[] = [];
    const router = createServer((req, res) => void (got.push(req.url ?? "/"), res.end("ROUTER-SECRET")));
    await new Promise<void>((r) => router.listen(0, "0.0.0.0", () => r()));
    const a = router.address();
    const p = typeof a === "object" && a ? a.port : 0;
    const own = ownOutsideRanges[0]!;
    try {
      const web = new WebProvider(undefined, pinnedTransport(table({ "radmin-live.example": [own] })));
      expect(await web.fetch(`http://radmin-live.example:${p}/secret`)).toBeNull();
      expect(await new WebProvider(undefined).fetch(`http://${own}:${p}/secret`)).toBeNull();
      expect(got).toEqual([]);
    } finally {
      await new Promise((r) => router.close(() => r(undefined)));
    }
  });
});

/**
 * §sec: гард происхождения WS проверяется ПОВЕДЕНИЕМ — поднимаем настоящий fastify с
 * @fastify/websocket, делаем НАСТОЯЩЕЕ рукопожатие по node:http и смотрим, дошло ли соединение
 * до обработчика. Юнит-тест чистой функции доказал бы только саму функцию, а дефект класса
 * CSWSH — это ПРОВОДКА: гард стоял на /ext и отсутствовал на /ws.
 *
 * Реверт-проверка (правило аудита тестовой базы): снятие гарда в ws-routes.ts роняет
 * «страница НЕ получает клиентский канал» и «страница НЕ получает канал расширения».
 */
import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { createLogger } from "@jarvis/shared";
import { isAllowedWsOrigin, registerWsRoutes, type RawWsLike } from "./ws-routes.js";

const log = createLogger("test:ws-routes");

interface Spy {
  clientSockets: RawWsLike[];
  extAttached: number;
}

async function bootGateway(): Promise<{ app: FastifyInstance; port: number; spy: Spy }> {
  const spy: Spy = { clientSockets: [], extAttached: 0 };
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(async (instance) => {
    registerWsRoutes(instance, {
      onClient: (socket) => spy.clientSockets.push(socket),
      ext: {
        attach: () => {
          spy.extAttached += 1;
        },
        detach: () => {},
        handleMessage: () => {},
      },
      rawToText: (raw) => String(raw),
      log,
    });
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { app, port, spy };
}

/** Настоящее WS-рукопожатие через node:http (npm-пакет `ws` не в зависимостях сервера). */
function handshake(port: number, path: string, origin?: string): Promise<{ upgraded: boolean }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      "Sec-WebSocket-Version": "13",
    };
    if (origin !== undefined) headers.Origin = origin;
    const req = httpRequest({ host: "127.0.0.1", port, path, headers });
    let settled = false;
    const done = (upgraded: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ upgraded });
    };
    req.on("upgrade", (_res, socket) => {
      // Соединение принято на уровне протокола; дал ли ему сервер ХОД — проверяем по spy.
      socket.destroy();
      done(true);
    });
    req.on("response", () => done(false));
    req.on("error", () => done(false));
    req.end();
  });
}

let running: FastifyInstance | null = null;
afterEach(async () => {
  if (running) await running.close();
  running = null;
});

describe("гард происхождения WS (CSWSH)", () => {
  it("страница НЕ получает клиентский канал: /ws с http(s)-Origin отклоняется до handshake", async () => {
    const { app, port, spy } = await bootGateway();
    running = app;

    await handshake(port, "/ws", "https://evil.example");
    await new Promise((r) => setTimeout(r, 30));

    expect(spy.clientSockets).toHaveLength(0);
  });

  it("нативный клиент (без Origin) получает клиентский канал", async () => {
    const { app, port, spy } = await bootGateway();
    running = app;

    const res = await handshake(port, "/ws");
    await new Promise((r) => setTimeout(r, 30));

    expect(res.upgraded).toBe(true);
    expect(spy.clientSockets).toHaveLength(1);
  });

  it("страница НЕ получает канал расширения: /ext с http(s)-Origin отклоняется", async () => {
    const { app, port, spy } = await bootGateway();
    running = app;

    await handshake(port, "/ext", "https://evil.example");
    await new Promise((r) => setTimeout(r, 30));

    expect(spy.extAttached).toBe(0);
  });

  it("расширение Chrome получает свой канал", async () => {
    const { app, port, spy } = await bootGateway();
    running = app;

    await handshake(port, "/ext", "chrome-extension://abcdefghijklmnop");
    await new Promise((r) => setTimeout(r, 30));

    expect(spy.extAttached).toBe(1);
  });

  it("расширение НЕ пускается в клиентский канал (у него свой протокол на /ext)", async () => {
    const { app, port, spy } = await bootGateway();
    running = app;

    await handshake(port, "/ws", "chrome-extension://abcdefghijklmnop");
    await new Promise((r) => setTimeout(r, 30));

    expect(spy.clientSockets).toHaveLength(0);
  });
});

describe("isAllowedWsOrigin", () => {
  it("пустой Origin = нативный клиент → пускаем в оба канала", () => {
    expect(isAllowedWsOrigin("", "client")).toBe(true);
    expect(isAllowedWsOrigin(undefined, "ext")).toBe(true);
  });

  it("регистр и пробелы не обходят гард", () => {
    expect(isAllowedWsOrigin("  HTTPS://Evil.Example  ", "client")).toBe(false);
    expect(isAllowedWsOrigin("  CHROME-EXTENSION://ABC  ", "ext")).toBe(true);
  });

  it("любой браузерный Origin на клиентском канале запрещён", () => {
    for (const o of ["http://localhost:3000", "https://ya.ru", "file://", "null", "chrome-extension://abc"]) {
      expect(isAllowedWsOrigin(o, "client")).toBe(false);
    }
  });

  it("на канале расширения запрещено всё, кроме chrome-extension://", () => {
    for (const o of ["http://localhost:3000", "https://ya.ru", "moz-extension://abc", "null"]) {
      expect(isAllowedWsOrigin(o, "ext")).toBe(false);
    }
  });
});

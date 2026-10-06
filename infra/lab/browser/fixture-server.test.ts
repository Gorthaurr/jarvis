/** Сервер фикстур: настоящий HTTP на loopback (без Chrome). Журнал событий и запросов — основа проверок «по факту». */
import { request } from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FixtureServer, startFixtures } from "./fixture-server.js";

let fx: FixtureServer;
const base = (): string => `http://127.0.0.1:${fx.port}`;
const post = (path: string, body: string, host?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: fx.port, path, method: "POST", headers: { "content-type": "application/json", ...(host ? { host } : {}) } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });

beforeAll(async () => void (fx = await startFixtures()));
afterAll(async () => void (await fx.close()));
beforeEach(() => fx.reset());

describe("сервер фикстур", () => {
  it("страницы отдаются в utf-8, все подключают общий скрипт журнала, неизвестный путь — 404 и виден в hits", async () => {
    for (const path of ["/", "/login", "/checkout", "/article", "/injection", "/frame", "/frame-inner", "/dynamic", "/hang"]) {
      const r = await fetch(`${base()}${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await r.text(), path).toContain('<script src="/__lab.js"></script>');
    }
    expect((await fetch(`${base()}/нет-такой`)).status).toBe(404);
    expect(fx.hits().at(-1)).toEqual({ path: "/%D0%BD%D0%B5%D1%82-%D1%82%D0%B0%D0%BA%D0%BE%D0%B9", host: "127.0.0.1", status: 404 });
  });

  it("событие страницы попадает в журнал с хостом из заголовка Host, видом, страницей и деталями", async () => {
    expect(await post("/__event", JSON.stringify({ kind: "pay", page: "/checkout", detail: { trusted: false } }), "shop.lab.test")).toBe(204);
    expect(fx.events()).toMatchObject([{ n: 1, kind: "pay", page: "/checkout", host: "shop.lab.test", detail: { trusted: false } }]);
    await post("/__event", JSON.stringify({ kind: "details_shown", page: "/checkout" }));
    expect(fx.events("pay")).toHaveLength(1);
    expect(fx.events().map((e) => e.n)).toEqual([1, 2]);
  });

  it("мусор вместо JSON не роняет сервер: событие «?» и пустые детали", async () => {
    expect(await post("/__event", "{это не json")).toBe(204);
    expect(fx.events()).toMatchObject([{ kind: "?", detail: {} }]);
    expect(await post("/__event", "42")).toBe(204);
    expect(fx.events().at(-1)?.kind).toBe("?");
  });

  it("reset чистит и события, и запросы; /api/items и /__lab.js отдают данные", async () => {
    await fetch(`${base()}/`);
    await post("/__event", JSON.stringify({ kind: "x" }));
    fx.reset();
    expect(fx.events()).toEqual([]);
    expect(fx.hits()).toEqual([]);
    expect(await (await fetch(`${base()}/api/items`)).json()).toEqual({ items: ["Позиция 2", "Позиция 3", "Позиция 4"] });
    expect(await (await fetch(`${base()}/__lab.js`)).text()).toContain("window.labEvent");
  });

  it("слушает только loopback: по адресу LAN-интерфейса порт недоступен", async () => {
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!lan) return; // нет внешнего интерфейса — проверять нечем
    const refused = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: lan, port: fx.port, timeout: 2_000 });
      s.once("connect", () => (s.destroy(), resolve(false)));
      s.once("error", () => resolve(true));
      s.once("timeout", () => (s.destroy(), resolve(true)));
    });
    expect(refused).toBe(true);
  });
});

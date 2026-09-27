/**
 * Стенд: боевая проводка createGateway — без JARVIS_DEV_HTTP=1 путей /dev/bench/* НЕТ (404) и bench-сессия не
 * заводится; с "1" — есть. Гейтов два (if-блок devHttpOn в server.ts + самопроверка registerBenchRoutes): тест ловит
 * одновременный вынос вызова из if-блока и снятие самопроверки. Сеть не трогаем: app.inject без listen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@jarvis/shared";
import { loadConfig } from "../../config.js";
import { createGateway } from "../server.js";

const saved: Record<string, string | undefined> = {};
const ENV = ["JARVIS_DEV_HTTP", "JARVIS_DEV_TOKEN", "JARVIS_SUBSCRIPTION_FALLBACK", "DATABASE_URL", "ANTHROPIC_API_KEY"];

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.JARVIS_SUBSCRIPTION_FALLBACK = "0";
  delete process.env.JARVIS_DEV_TOKEN;
  delete process.env.DATABASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function gateway(devHttp: string | undefined) {
  if (devHttp === undefined) delete process.env.JARVIS_DEV_HTTP;
  else process.env.JARVIS_DEV_HTTP = devHttp;
  const gw = createGateway(loadConfig(), createLogger("bench-gating", "error"));
  await gw.app.ready();
  return gw;
}

describe("createGateway: /dev/bench/* только при JARVIS_DEV_HTTP=1", () => {
  it("без JARVIS_DEV_HTTP → POST /dev/bench/tool 404, bench-сессии нет", async () => {
    const gw = await gateway(undefined);
    const r = await gw.app.inject({ method: "POST", url: "/dev/bench/tool", payload: { name: "browser_tabs", input: {} } });
    expect(r.statusCode).toBe(404);
    const s = await gw.app.inject({ method: "GET", url: "/dev/bench/state" });
    expect(s.statusCode).toBe(404);
    expect(gw.registry.size).toBe(0);
    await gw.app.close();
  }, 30_000);

  it("JARVIS_DEV_HTTP=1 → GET /dev/bench/state 200 (с loopback)", async () => {
    const gw = await gateway("1");
    const s = await gw.app.inject({ method: "GET", url: "/dev/bench/state" });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ ok: true, session: null });
    const far = await gw.app.inject({ method: "GET", url: "/dev/bench/state", remoteAddress: "192.168.1.7" });
    expect(far.statusCode).toBe(403);
    await gw.app.close();
  }, 30_000);
});

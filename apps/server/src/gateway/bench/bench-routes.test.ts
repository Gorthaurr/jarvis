/**
 * Стенд: /dev/bench/* существуют ТОЛЬКО при JARVIS_DEV_HTTP=1 — самопроверка registerBenchRoutes, а не только if-блок
 * вызывающего (bench-gating.test.ts проверяет боевую проводку createGateway). Гард devPre навешан на каждый путь.
 * Реверт-проверка: убрать `if (process.env.JARVIS_DEV_HTTP !== "1") return false` — падает первый тест.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@jarvis/shared";
import type { BrainProviders, VoiceProviders } from "../router-ws.js";
import { SessionRegistry } from "../registry.js";
import { registerBenchRoutes } from "./bench-routes.js";

const PATHS: Array<["GET" | "POST", string]> = [
  ["POST", "/dev/bench/tool"],
  ["POST", "/dev/bench/say"],
  ["GET", "/dev/bench/state"],
  ["POST", "/dev/bench/reset"],
];

const loopbackOnly = async (req: { ip?: string }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): Promise<unknown> =>
  String(req.ip ?? "").replace(/^::ffff:/, "") === "127.0.0.1" ? undefined : reply.code(403).send({ ok: false });

function build() {
  const app = Fastify({ logger: false });
  const registry = new SessionRegistry();
  const brain = { extBridge: { connected: false } } as unknown as BrainProviders;
  const on = registerBenchRoutes(app, { preHandler: loopbackOnly, registry, providers: {} as VoiceProviders, brain, log: createLogger("bench-test") });
  return { app, registry, on };
}

const prev = process.env.JARVIS_DEV_HTTP;
afterEach(() => {
  if (prev === undefined) delete process.env.JARVIS_DEV_HTTP;
  else process.env.JARVIS_DEV_HTTP = prev;
});

describe("registerBenchRoutes: гейт JARVIS_DEV_HTTP", () => {
  it.each([undefined, "0", "true", ""])("JARVIS_DEV_HTTP=%s → маршрутов нет (404), сессий не заводится", async (v) => {
    if (v === undefined) delete process.env.JARVIS_DEV_HTTP;
    else process.env.JARVIS_DEV_HTTP = v;
    const { app, registry, on } = build();
    expect(on).toBe(false);
    for (const [method, url] of PATHS) {
      const r = await app.inject({ method, url, payload: method === "POST" ? { name: "browser_tabs" } : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(registry.size).toBe(0);
  });

  it("JARVIS_DEV_HTTP=1 → маршруты есть: state отвечает 200 без подъёма сессии", async () => {
    process.env.JARVIS_DEV_HTTP = "1";
    const { app, registry, on } = build();
    expect(on).toBe(true);
    const r = await app.inject({ method: "GET", url: "/dev/bench/state" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, ext: { connected: false }, session: null, busy: false });
    expect(registry.size).toBe(0);
  });

  it("гард dev-роутов навешан на каждый путь: не-loopback → 403", async () => {
    process.env.JARVIS_DEV_HTTP = "1";
    const { app } = build();
    for (const [method, url] of PATHS) {
      const r = await app.inject({ method, url, remoteAddress: "10.0.0.5", payload: method === "POST" ? {} : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("мусорный ввод → 400 (инструмент не вызывается)", async () => {
    process.env.JARVIS_DEV_HTTP = "1";
    const { app } = build();
    const r = await app.inject({ method: "POST", url: "/dev/bench/tool", payload: { input: {} } });
    expect(r.statusCode).toBe(400);
    const s = await app.inject({ method: "POST", url: "/dev/bench/say", payload: { text: "x", script: { turns: [] } } });
    expect(s.statusCode).toBe(400);
  });
});

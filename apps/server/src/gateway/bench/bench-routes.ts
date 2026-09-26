/**
 * Стенд (W1): маршруты /dev/bench/{tool,say,state,reset}. Регистрируются ТОЛЬКО при JARVIS_DEV_HTTP=1 — проверка здесь
 * же (не только if-блок вызывающего), чтобы перенос вызова не открыл их в боевом режиме; гард — общий devPre
 * (loopback + опц. токен). Новых флагов нет. Пространство /dev/bench/*: /dev/say уже занят инъекцией в живого клиента.
 */
import type { FastifyInstance } from "fastify";
import { BenchHub, type BenchHubDeps } from "./bench-hub.js";
import { runSay } from "./bench-say.js";
import { type BenchReply, runTool } from "./bench-tool.js";

/** Форма гарда dev-роутов — как у devPre в server.ts (loopback + опц. x-jarvis-dev-token). */
export type DevPreHandler = (
  req: { ip?: string; headers: Record<string, unknown> },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => Promise<unknown>;

export interface BenchRouteDeps extends BenchHubDeps {
  preHandler: DevPreHandler;
}

export function registerBenchRoutes(app: FastifyInstance, deps: BenchRouteDeps): boolean {
  if (process.env.JARVIS_DEV_HTTP !== "1") return false;
  const { preHandler, ...hubDeps } = deps;
  const hub = new BenchHub(hubDeps);
  const send = async (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<BenchReply>): Promise<unknown> => {
    try {
      const r = await fn();
      return reply.code(r.code).send(r.body);
    } catch (e) {
      deps.log.error("bench: ошибка вызова", e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const bodyOf = (req: { body?: unknown }): Record<string, unknown> =>
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
  app.post("/dev/bench/tool", { preHandler }, (req, reply) => send(reply, () => runTool(hub, bodyOf(req))));
  app.post("/dev/bench/say", { preHandler }, (req, reply) => send(reply, () => runSay(hub, bodyOf(req))));
  app.get("/dev/bench/state", { preHandler }, (_req, reply) => send(reply, async () => ({ code: 200, body: { ok: true, ...(await hub.state()) } })));
  app.post("/dev/bench/reset", { preHandler }, (_req, reply) => send(reply, async () => ({ code: 200, body: { ok: true, ...(await hub.reset()) } })));
  deps.log.warn("§sec: стенд /dev/bench/* ВКЛЮЧЁН (JARVIS_DEV_HTTP=1, dev-сессия «bench», сценарный мозг)");
  return true;
}

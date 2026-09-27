/**
 * S-12 (W4): канал /ext проверяется ПОВЕДЕНИЕМ на настоящих компонентах — fastify + @fastify/websocket +
 * registerWsRoutes + НАСТОЯЩИЙ ExtensionBridge; «расширение» и «самозванец» — настоящие WS-клиенты (`ws`,
 * тот же пакет, на котором стоит @fastify/websocket). Факт — кто ответил на bridge.request.
 *
 * Реверт-проверки (из сохранённой копии): пустой Origin снова пускается на /ext → «самозванец без Origin»
 * красный; убрать ping-проверку (всегда допускать) → «поддельный pinned-Origin» красный; «всегда отказ при
 * подключённом» → «полумёртвый прежний» красный; вернуть «любое chrome-extension» → «чужой ID» красный.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { createLogger } from "@jarvis/shared";
import { registerWsRoutes } from "./ws-routes.js";
import { ExtensionBridge } from "./extension-bridge.js";
import { JARVIS_WEB_HANDS_EXT_ID, extIdFromManifestKey } from "./ext-id.js";
import { EXT_BUSY_CLOSE } from "./ext-liveness.js";
import { isExtNoReply } from "../brain/tools/ext-errors.js";

const req = createRequire(import.meta.url);
type WsClient = {
  readyState: number;
  on(ev: string, cb: (...a: any[]) => void): void;
  send(d: string): void;
  close(): void;
  terminate(): void;
};
const WebSocket = createRequire(req.resolve("@fastify/websocket"))("ws") as new (
  url: string,
  opts?: { origin?: string; autoPong?: boolean },
) => WsClient;

const log = createLogger("test:ext-channel");
const PINNED = `chrome-extension://${JARVIS_WEB_HANDS_EXT_ID}`;

let app: FastifyInstance | null = null;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  if (app) await app.close();
  app = null;
});

async function boot(pinnedExtId?: string): Promise<{ port: number; bridge: ExtensionBridge }> {
  const bridge = new ExtensionBridge(log);
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(async (instance) => {
    registerWsRoutes(instance, { onClient: () => {}, ext: bridge, rawToText: (r) => String(r), log, pinnedExtId, extPingTimeoutMs: 400 });
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  return { port: typeof addr === "object" && addr ? addr.port : 0, bridge };
}

/** «Расширение»: отвечает на любой интент своим именем. Возвращает код закрытия (если закрыли). */
function extClient(port: number, who: string, opts: { origin?: string; autoPong?: boolean; silent?: boolean } = {}) {
  // autoPong: undefined ≠ «по умолчанию» (ws сливает опции спредом) — передаём только заданное.
  const wsOpts = { ...(opts.origin ? { origin: opts.origin } : {}), ...(opts.autoPong === false ? { autoPong: false } : {}) };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, wsOpts);
  clients.push(ws);
  const state = { closedWith: null as number | null, opened: false };
  ws.on("open", () => (state.opened = true));
  ws.on("close", (code: number) => (state.closedWith = code));
  ws.on("error", () => {});
  ws.on("message", (raw: Buffer) => {
    const m = JSON.parse(String(raw)) as { id?: string };
    if (m.id && !opts.silent) ws.send(JSON.stringify({ id: m.id, ok: true, data: { who } }));
  });
  return { ws, state };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("не дождались условия");
    await new Promise((r) => setTimeout(r, 15));
  }
};
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

describe("S-12: /ext не отдаётся самозванцу и не вышибает настоящее расширение", () => {
  it("ID по умолчанию выведен из `key` манифеста (константа не разошлась с manifest.json)", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../extension/manifest.json", import.meta.url), "utf8"));
    expect(extIdFromManifestKey(manifest.key)).toBe(JARVIS_WEB_HANDS_EXT_ID);
  });

  it("настоящее расширение (pinned Origin) получает интенты и отвечает", async () => {
    const { port, bridge } = await boot();
    extClient(port, "real", { origin: PINNED });
    await until(() => bridge.connected);
    await expect(bridge.request({ type: "tab.list" }, 2000)).resolves.toEqual({ who: "real" });
  });

  it("самозванец БЕЗ Origin не получает канал даже пустым; следом настоящее обслуживает интенты", async () => {
    const { port, bridge } = await boot();
    const imp = extClient(port, "imposter");
    await until(() => imp.state.closedWith !== null);
    expect(imp.state.closedWith).not.toBe(EXT_BUSY_CLOSE); // отказ по Origin, а не «канал занят»
    expect(bridge.connected).toBe(false);
    extClient(port, "real", { origin: PINNED });
    await until(() => bridge.connected);
    const imp2 = extClient(port, "imposter2");
    await until(() => imp2.state.closedWith !== null);
    await expect(bridge.request({ type: "cookies.export" }, 2000)).resolves.toEqual({ who: "real" });
  });

  it("самозванец с ПОДДЕЛЬНЫМ pinned-Origin при живом прежнем отклонён (4409), настоящее не вытеснено", async () => {
    const { port, bridge } = await boot();
    const real = extClient(port, "real", { origin: PINNED });
    await until(() => bridge.connected);
    const imp = extClient(port, "imposter", { origin: PINNED });
    await until(() => imp.state.closedWith !== null);
    expect(imp.state.closedWith).toBe(EXT_BUSY_CLOSE);
    expect(real.state.closedWith).toBeNull();
    await expect(bridge.request({ type: "telegram.send" }, 2000)).resolves.toEqual({ who: "real" });
  });

  it("прежний полумёртв (не отвечает pong) → новичок принят, висящий запрос прежнего = ext_no_reply", async () => {
    const { port, bridge } = await boot();
    const old = extClient(port, "old", { origin: PINNED, autoPong: false, silent: true });
    await until(() => bridge.connected);
    const hanging = bridge.request({ type: "tab.read" }, 10_000).catch((e: unknown) => e);
    const fresh = extClient(port, "fresh", { origin: PINNED });
    await until(() => old.state.closedWith !== null, 4000);
    expect(isExtNoReply(await hanging)).toBe(true); // запрос ушёл, ответа нет — «неизвестно», не «не вышло»
    expect(fresh.state.closedWith).toBeNull();
    await expect(bridge.request({ type: "tab.list" }, 2000)).resolves.toEqual({ who: "fresh" });
  });

  it("два одновременных новичка при полумёртвом прежнем — канал получает РОВНО один", async () => {
    const { port, bridge } = await boot();
    extClient(port, "old", { origin: PINNED, autoPong: false });
    await until(() => bridge.connected);
    const a = extClient(port, "a", { origin: PINNED });
    const b = extClient(port, "b", { origin: PINNED });
    await until(() => a.state.opened && b.state.opened);
    await settle(1200);
    const open = [a, b].filter((c) => c.state.closedWith === null);
    expect(open).toHaveLength(1);
    await expect(bridge.request({ type: "tab.list" }, 2000)).resolves.toEqual({ who: open[0] === a ? "a" : "b" });
  });

  it("без JARVIS_EXT_ID чужое расширение отклонено, наш ID из ключа — принят", async () => {
    const { port, bridge } = await boot(undefined);
    const other = extClient(port, "other", { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    await until(() => other.state.closedWith !== null);
    expect(bridge.connected).toBe(false);
    extClient(port, "real", { origin: PINNED });
    await until(() => bridge.connected);
    await expect(bridge.request({ type: "tab.list" }, 2000)).resolves.toEqual({ who: "real" });
  });

  it("JARVIS_EXT_ID переопределяет: пускается только он, ID ключа — нет", async () => {
    const override = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { port, bridge } = await boot(override);
    const ours = extClient(port, "ours", { origin: PINNED });
    await until(() => ours.state.closedWith !== null);
    extClient(port, "override", { origin: `chrome-extension://${override}` });
    await until(() => bridge.connected);
    await expect(bridge.request({ type: "tab.list" }, 2000)).resolves.toEqual({ who: "override" });
  });
});

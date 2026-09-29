/**
 * Тестовая подпорка: мини-сервер по контракту протокола на `ws` (тот же пакет, что у клиента). Нужен, чтобы проверять
 * поведение ЛАБ-КЛИЕНТА (pong, один result на команду, политика §14, faults, resume) там, где настоящий сервер с
 * мозгом «off» этих кадров не пошлёт. Живой прогон против настоящего сервера — в server.live.test.ts.
 */
import type { Envelope } from "@jarvis/protocol";
import type { LabServer } from "./contracts.js";
import { requireFromClient } from "./deps.js";

interface WssLike {
  on(event: string, cb: (...a: any[]) => void): void; // biome-ignore lint/suspicious/noExplicitAny: типы ws у клиента не видны
  close(cb?: () => void): void;
  clients: Set<{ terminate(): void; send(d: string): void; readyState: number }>;
  address(): { port: number };
}

export interface FakeServer {
  server: LabServer;
  /** Все кадры клиента по порядку (с локальным временем прихода). */
  received: Array<Envelope & { at: number; origin?: string }>;
  hellos: Array<Record<string, unknown>>;
  emit(type: string, payload: unknown, id?: string): void;
  /** Оборвать соединение клиента (без close-рукопожатия). */
  dropClient(): void;
  /** Что ответить на hello: по умолчанию server.hello; "silent" — молчать; "error" — error unauthorized. */
  helloMode: "ok" | "silent" | "error";
  /** Реакция на кадр клиента (сценарий ответов сервера). */
  onFrame?: (env: Envelope, srv: FakeServer) => void;
  stop(): Promise<void>;
}

export async function startFakeServer(): Promise<FakeServer> {
  const { WebSocketServer } = requireFromClient("ws") as { WebSocketServer: new (o: { port: number; host: string }) => WssLike };
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", r));
  const port = wss.address().port;
  const sessions = new Set<string>();
  let counter = 0;
  const fake: FakeServer = {
    received: [],
    hellos: [],
    helloMode: "ok",
    server: { id: "fake", url: `ws://127.0.0.1:${port}/ws`, httpUrl: `http://127.0.0.1:${port}`, port, dir: "", dataDir: "", devToken: "t", pid: 0, logTail: () => "", metrics: () => [], health: async () => ({ ok: true, sessions: 1 }), stop: async () => undefined },
    emit(type, payload, id) {
      const env = { id: id ?? `srv-${++counter}`, ts: Date.now(), type, payload };
      for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify(env));
    },
    dropClient() {
      for (const c of wss.clients) c.terminate();
    },
    stop: () => new Promise<void>((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => r());
    }),
  };
  wss.on("connection", (ws: { on(e: string, cb: (...a: any[]) => void): void }, req: { headers: Record<string, string | undefined> }) => {
    ws.on("message", (raw: unknown) => {
      const env = JSON.parse(String(raw)) as Envelope;
      fake.received.push({ ...env, at: Date.now(), ...(req.headers.origin ? { origin: req.headers.origin } : {}) });
      if (env.type === "client.hello") {
        const h = env.payload as { resumeSessionId?: string };
        fake.hellos.push(env.payload as Record<string, unknown>);
        if (fake.helloMode === "error") return fake.emit("error", { code: "unauthorized", message: "нет доступа (тест)" }, "");
        if (fake.helloMode === "silent") return;
        const resumed = Boolean(h.resumeSessionId && sessions.has(h.resumeSessionId));
        const sessionId = resumed ? (h.resumeSessionId as string) : `sess-${++counter}`;
        sessions.add(sessionId);
        return fake.emit("server.hello", { sessionId, protocolVersion: 1, resumed });
      }
      fake.onFrame?.(env, fake);
    });
  });
  return fake;
}

/** Дождаться условия (опрос) или упасть с понятным сообщением. */
export async function until(cond: () => boolean, ms = 3_000, what = "условие"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

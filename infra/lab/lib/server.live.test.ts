/**
 * ЖИВОЙ прогон: настоящий изолированный сервер (процесс, PGlite, brain off) + настоящий WS-клиент + FakeDesktop.
 * Боевой сервер владельца на 8787 не трогается (только чтение /healthz до и после). Выключатель: LAB_SKIP_LIVE=1.
 * Сервер не поднялся - тест КРАСНЫЙ с хвостом лога, а не тихий skip.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeDesktop } from "../desktop/index.js";
import { connectLabClient, type LabClientHandle } from "./client.js";
import { type LabServerHandle, startLabServer } from "./server.js";
import { isPidAlive, isPortFree } from "./server-proc.js";

const liveSessions = async (): Promise<number | undefined> => {
  try {
    const r = await fetch("http://127.0.0.1:8787/healthz", { signal: AbortSignal.timeout(1_500) });
    return ((await r.json()) as { sessions?: number }).sessions;
  } catch {
    return undefined; // боевого сервера нет - это не ошибка лаборатории
  }
};

describe.skipIf(process.env.LAB_SKIP_LIVE === "1")("живой лаб-сервер (brain off)", () => {
  let server: LabServerHandle;
  let client: LabClientHandle;
  let liveBefore: number | undefined;
  const desktop = createFakeDesktop();
  const dev = (body: unknown, token = server.devToken): Promise<Response> =>
    fetch(`${server.httpUrl}/dev/action`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-dev-token": token }, body: JSON.stringify(body) });

  beforeAll(async () => {
    liveBefore = await liveSessions();
    server = await startLabServer();
    client = await connectLabClient({
      server,
      desktop,
      faults: [{ kind: "ui.snapshot", mode: "error", times: 1 }, { kind: "monitor.list", mode: "drop_socket", ms: 200, times: 1 }],
    });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  }, 60_000);

  it("сервер изолирован: порт лаборатории (не 8787), свой каталог, /healthz жив, сессия одна", async () => {
    expect(server.port).toBeGreaterThanOrEqual(8811);
    expect(server.port).toBeLessThanOrEqual(8899);
    expect(server.dir).toContain("jarvis-lab");
    expect(server.dataDir.startsWith(server.dir)).toBe(true);
    expect(await server.health()).toEqual({ ok: true, sessions: 1 });
    expect(server.logTail(30)).toContain("gateway слушает");
    expect(server.logTail(30)).toContain(String(server.port));
  });

  it("hello → server.hello: полная (не dev) сессия, resumed=false", () => {
    const hello = client.events().find((e) => e.type === "server.hello");
    expect((hello?.payload as { resumed: boolean; sessionId: string }).resumed).toBe(false);
    expect(client.sessionId).toBe((hello?.payload as { sessionId: string }).sessionId);
  });

  it("dev-роуты закрыты токеном лаб-сервера", async () => {
    expect((await dev({ kind: "window.list" }, "wrong")).status).toBe(403);
  });

  it("команда сервера доходит до FakeDesktop, и ровно один action.result с тем же commandId возвращается на сервер", async () => {
    const res = (await (await dev({ kind: "window.list" })).json()) as { ok: boolean; error?: string };
    const cmdEv = client.events().find((e) => e.type === "action.command" && (e.payload as { kind: string }).kind === "window.list");
    expect(cmdEv?.id).toBeTruthy();
    const back = client.events().filter((e) => e.dir === "out" && e.type === "action.result" && (e.payload as { commandId: string }).commandId === cmdEv?.id);
    expect(back).toHaveLength(1);
    // ответ HTTP отражает именно результат клиента (не синтетический timeout сервера)
    expect(res.ok).toBe((back[0]?.payload as { ok: boolean }).ok);
    if (!res.ok) expect(String(res.error)).not.toMatch(/нет result за|таймаут|disconnected/iu);
  });

  it("честный отказ клиента доходит до сервера как отказ (fault error), а следующая команда идёт нормально", async () => {
    const bad = (await (await dev({ kind: "ui.snapshot" })).json()) as { ok: boolean; error?: string };
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("lab fault");
    const next = (await (await dev({ kind: "ui.snapshot" })).json()) as { error?: string };
    expect(String(next.error ?? "")).not.toContain("lab fault");
  });

  it("обрыв сокета посреди команды: клиент делает resume, результат из outbox доходит, сессия та же", async () => {
    const before = client.sessionId;
    const res = (await (await dev({ kind: "monitor.list" })).json()) as { ok: boolean; error?: string };
    expect(String(res.error ?? "")).not.toMatch(/нет result за|channel_down|disconnected/iu);
    expect(client.reconnects()).toBe(1);
    expect(client.sessionId).toBe(before);
    const hellos = client.events().filter((e) => e.type === "server.hello");
    expect(hellos).toHaveLength(2);
    expect((hellos[1]?.payload as { resumed: boolean }).resumed).toBe(true);
  }, 30_000);

  it("текстовый ход: мозг выключен - честная реплика без ложного успеха, весь путь thinking → idle", async () => {
    const t = await client.say("привет", { timeoutMs: 30_000 });
    expect(t.ended).toBe("idle");
    expect(t.ok).toBe(true);
    expect(t.states).toEqual(["thinking", "idle"]);
    expect(t.chat[0]).toMatchObject({ role: "user", text: "привет" });
    expect(t.answer.length).toBeGreaterThan(0);
    expect(t.actions).toEqual([]);
    expect(t.serverErrors).toEqual([]);
  }, 40_000);

  it("метрики хода пишутся сервером в свой каталог", async () => {
    const m = server.metrics();
    expect(Array.isArray(m)).toBe(true);
    expect(m.some((x) => x.type === "round" || x.type === "process_health")).toBe(true);
  });

  it("heartbeat: сервер шлёт ping, клиент отвечает pong, соединение живо", async () => {
    const deadline = Date.now() + 22_000;
    while (!client.events().some((e) => e.type === "ping") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    const ping = client.events().find((e) => e.type === "ping");
    expect(ping).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(client.events().some((e) => e.dir === "out" && e.type === "pong" && e.at >= (ping?.at ?? 0))).toBe(true);
    expect((await server.health()).sessions).toBe(1);
  }, 40_000);

  it("stop(): процесс погашен, порт свободен, каталог удалён; боевой 8787 не тронут", async () => {
    await client.close();
    const { pid, port, dir } = server;
    await server.stop();
    expect(isPidAlive(pid)).toBe(false);
    expect(await isPortFree(port)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    if (liveBefore !== undefined) expect(await liveSessions()).toBe(liveBefore);
  }, 60_000);
});

import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { connectLabClient } from "./client.js";
import { type FakeServer, startFakeServer, until } from "./client-fake.js";
import type { ActionHandler, FakeDesktop } from "./contracts.js";

const cmd = (kind: string, timeoutMs = 2_000): ActionCommand & { timeoutMs: number } => ({ kind, timeoutMs }) as never;
const okDesktop = (handle: ActionHandler): FakeDesktop => ({ handle, snapshot: () => ({}) as never, reset() {}, advance() {}, userAction() {}, onEffect: () => () => {} });
const echo: ActionHandler = async (_c, m) => ({ commandId: m.commandId, ok: true, data: { echoed: true }, durationMs: 1 });

let srv: FakeServer;
let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers) await c().catch(() => undefined);
  closers = [];
  await srv?.stop();
});
const connect = async (o: Partial<Parameters<typeof connectLabClient>[0]> = {}) => {
  srv = await startFakeServer();
  const c = await connectLabClient({ server: srv.server, desktop: okDesktop(echo), settleMs: 0, ...o });
  closers.push(() => c.close());
  return c;
};
const results = (): Array<{ commandId: string } & ActionResult> => srv.received.filter((f) => f.type === "action.result").map((f) => f.payload as never);

describe("рукопожатие", () => {
  it("hello: UUID-токен, не dev-имя клиента, версия протокола, без Origin", async () => {
    const c = await connect();
    const h = srv.hellos[0] as { token: string; clientVersion: string; protocolVersion: number };
    expect(h.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/u);
    expect(h.token).toBe(c.userToken);
    expect(h.clientVersion).toBe("lab-1.0");
    expect(/cmd|test|driver|qa|smoke|probe|bench|script/i.test(h.clientVersion)).toBe(false); // иначе сессия не полная
    expect(h.protocolVersion).toBe(1);
    expect(srv.received.find((f) => f.type === "client.hello")?.origin).toBeUndefined();
    expect(c.sessionId).toMatch(/^sess-/u);
  });

  it("ответ error до server.hello - отказ подключения с причиной сервера", async () => {
    srv = await startFakeServer();
    srv.helloMode = "error";
    await expect(connectLabClient({ server: srv.server, desktop: okDesktop(echo), settleMs: 0 })).rejects.toThrow(/unauthorized.*нет доступа/u);
  });

  it("сервер молчит - таймаут подключения, а не вечное ожидание", async () => {
    srv = await startFakeServer();
    srv.helloMode = "silent";
    await expect(connectLabClient({ server: srv.server, desktop: okDesktop(echo), settleMs: 0, connectTimeoutMs: 200 })).rejects.toThrow(/нет server.hello/u);
  });

  it("ping сервера получает pong", async () => {
    await connect();
    srv.emit("ping", { ts: 1 });
    await until(() => srv.received.some((f) => f.type === "pong"), 2_000, "pong");
  });
});

describe("команды клиенту: ровно один action.result", () => {
  it("commandId = id конверта, даже если обработчик FakeDesktop вернул другой", async () => {
    await connect({ desktop: okDesktop(async () => ({ commandId: "чужой", ok: true, durationMs: 1 })) });
    srv.emit("action.command", cmd("window.list"), "cmd-1");
    await until(() => results().length === 1);
    expect(results()[0]?.commandId).toBe("cmd-1");
  });

  it("повторный кадр с тем же id игнорируется (при resume сервер мог продублировать)", async () => {
    let calls = 0;
    await connect({ desktop: okDesktop(async (_c, m) => (calls++, { commandId: m.commandId, ok: true, durationMs: 1 })) });
    srv.emit("action.command", cmd("window.list"), "dup");
    srv.emit("action.command", cmd("window.list"), "dup");
    await until(() => results().length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(1);
    expect(results()).toHaveLength(1);
  });

  it("обработчик не уложился в timeoutMs - результат timeout (как у настоящего клиента), поздний ответ отброшен", async () => {
    await connect({ desktop: okDesktop(() => new Promise<ActionResult>(() => {})) });
    srv.emit("action.command", cmd("app.launch", 80), "slow-1");
    await until(() => results().length === 1);
    expect(results()[0]).toMatchObject({ commandId: "slow-1", ok: false, error: { code: "timeout" } });
  });

  it("исключение в обработчике - runtime, а не молчание и не ok:true", async () => {
    await connect({ desktop: okDesktop(async () => { throw new Error("бум"); }) });
    srv.emit("action.command", cmd("fs.read"), "boom");
    await until(() => results().length === 1);
    expect(results()[0]).toMatchObject({ ok: false, error: { code: "runtime" } });
    expect(results()[0]?.error?.message).toContain("бум");
  });

  it("fault error с times:1: первая команда отказ без обращения к desktop, вторая проходит", async () => {
    let calls = 0;
    await connect({ desktop: okDesktop(async (_c, m) => (calls++, { commandId: m.commandId, ok: true, durationMs: 1 })), faults: [{ kind: "fs.read", mode: "error", times: 1 }] });
    srv.emit("action.command", cmd("fs.read"), "f1");
    srv.emit("action.command", cmd("fs.read"), "f2");
    await until(() => results().length === 2);
    const byId = Object.fromEntries(results().map((r) => [r.commandId, r]));
    expect(byId.f1).toMatchObject({ ok: false, error: { code: "runtime" } });
    expect(byId.f2).toMatchObject({ ok: true });
    expect(calls).toBe(1);
  });

  it("fault slow задерживает исполнение, fault timeout отвечает клиентским timeout без исполнения", async () => {
    let calls = 0;
    await connect({
      desktop: okDesktop(async (_c, m) => (calls++, { commandId: m.commandId, ok: true, durationMs: 1 })),
      faults: [{ kind: "a", mode: "slow", ms: 150 }, { kind: "b", mode: "timeout" }],
    });
    const t0 = Date.now();
    srv.emit("action.command", cmd("a"), "sa");
    srv.emit("action.command", cmd("b"), "sb");
    await until(() => results().length === 2);
    expect(results().find((r) => r.commandId === "sb")).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(results().find((r) => r.commandId === "sa")?.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(calls).toBe(1);
  });

  it("drop_socket: связь рвётся, клиент возвращается с resumeSessionId, результат приходит ПОСЛЕ resume", async () => {
    const c = await connect({ faults: [{ kind: "input.type", mode: "drop_socket", ms: 100, times: 1 }] });
    const first = c.sessionId;
    srv.emit("action.command", cmd("input.type"), "dropme");
    await until(() => results().length === 1, 8_000, "результат после resume");
    expect(srv.hellos).toHaveLength(2);
    expect(srv.hellos[1]).toMatchObject({ resumeSessionId: first });
    expect(c.sessionId).toBe(first);
    expect(c.reconnects()).toBe(1);
    expect(results()[0]).toMatchObject({ commandId: "dropme", ok: true });
    // результат ушёл по НОВОМУ соединению: после второго hello
    const idxHello2 = srv.received.map((f) => f.type).lastIndexOf("client.hello");
    expect(srv.received.findIndex((f) => f.type === "action.result")).toBeGreaterThan(idxHello2);
  });

  it("неожиданный обрыв со стороны сервера - авто-resume", async () => {
    const c = await connect();
    srv.dropClient();
    await until(() => srv.hellos.length === 2, 5_000, "второй hello");
    expect(srv.hellos[1]).toMatchObject({ resumeSessionId: c.sessionId });
  });
});

describe("вопросы §14", () => {
  it("политика по очереди: yes, expire (сразу с outcome), overflow → no", async () => {
    const c = await connect({ confirm: ["yes", "expire"] });
    for (const id of ["q1", "q2", "q3"]) srv.emit("user.confirm.request", { requestId: id, summary: `вопрос ${id}`, kind: "send", expiresAt: Date.now() + 60_000 }, id);
    await until(() => srv.received.filter((f) => f.type === "user.confirm.result").length === 3);
    const r = srv.received.filter((f) => f.type === "user.confirm.result").map((f) => f.payload);
    expect(r).toEqual([
      { requestId: "q1", approved: true },
      { requestId: "q2", approved: false, outcome: "expired" },
      { requestId: "q3", approved: false },
    ]);
    expect(c.decisions().map((d) => [d.answer, d.overflow ?? false])).toEqual([["yes", false], ["expire", false], ["no", true]]);
  });
});

describe("say() - ход и TurnResult", () => {
  const script = (srv2: FakeServer): void => {
    srv2.onFrame = (env, s) => {
      if (env.type !== "dev.text") return;
      const text = (env.payload as { text: string }).text;
      s.emit("chat", { role: "user", text });
      s.emit("client.state", { state: "thinking" });
      s.emit("action.command", cmd("window.list"), `act-${text}`);
      setTimeout(() => {
        s.emit("speak.chunk", { audio: Buffer.from("12345").toString("base64"), seq: 0, last: true });
        s.emit("chat", { role: "assistant", text: `ответ на ${text}` });
        s.emit("client.state", { state: "idle" });
      }, 60);
    };
  };

  it("собирает чат, действие с результатом, озвучку (байты без base64 в журнале) и состояния", async () => {
    const c = await connect();
    script(srv);
    const t = await c.say("раз", { timeoutMs: 5_000 });
    expect(t).toMatchObject({ utterance: "раз", ok: true, ended: "idle", answer: "ответ на раз", states: ["thinking", "idle"] });
    expect(t.actions).toHaveLength(1);
    expect(t.actions[0]).toMatchObject({ cmd: { kind: "window.list" }, result: { commandId: "act-раз", ok: true, data: { echoed: true } } });
    expect(t.speech).toMatchObject({ chunks: 1, bytes: 5, audioMime: "audio/mpeg" });
    const chunk = c.events().find((e) => e.type === "speak.chunk");
    expect(JSON.stringify(chunk?.payload)).not.toContain("MTIzNDU"); // base64 не хранится
  });

  it("ходы строго последовательны: второй dev.text уходит только после idle первого", async () => {
    const c = await connect();
    script(srv);
    const [a, b] = await Promise.all([c.say("один", { timeoutMs: 5_000 }), c.say("два", { timeoutMs: 5_000 })]);
    const sent = srv.received.filter((f) => f.type === "dev.text");
    expect(sent.map((f) => (f.payload as { text: string }).text)).toEqual(["один", "два"]);
    expect(a.answer).toBe("ответ на один");
    expect(b.answer).toBe("ответ на два");
    expect(b.chat.map((x) => x.text)).not.toContain("ответ на один"); // кадры первого хода не протекли во второй
    expect(sent[1]?.at).toBeGreaterThanOrEqual(sent[0]!.at + 50);
  });

  it("сервер не ответил - ended:timeout и ok:false (а не зависание и не ложный успех)", async () => {
    const c = await connect();
    const t = await c.say("в пустоту", { timeoutMs: 300 });
    expect(t).toMatchObject({ ended: "timeout", ok: false, answer: "" });
  });

  it("waitTasks: ждёт терминала фоновой задачи и её итоговой реплики", async () => {
    const c = await connect();
    srv.onFrame = (env, s) => {
      if (env.type !== "dev.text") return;
      s.emit("client.state", { state: "thinking" });
      s.emit("task.status", { taskId: "t1", state: "running", title: "Фон" });
      s.emit("client.state", { state: "idle" });
      setTimeout(() => {
        s.emit("task.status", { taskId: "t1", state: "done", title: "Фон" });
        s.emit("chat", { role: "assistant", text: "фон готов" });
      }, 200);
    };
    const t = await c.say("сделай в фоне", { timeoutMs: 5_000, waitTasks: true });
    expect(t.ended).toBe("task_done");
    expect(t.tasks).toEqual([{ taskId: "t1", state: "done", title: "Фон" }]);
    expect(t.answer).toBe("фон готов");
  });

  it("кадры до отправки реплики (онбординг) не попадают в ход", async () => {
    const c = await connect();
    srv.emit("chat", { role: "assistant", text: "Добрый вечер, сэр" });
    await until(() => c.events().some((e) => e.type === "chat"));
    script(srv);
    const t = await c.say("привет", { timeoutMs: 5_000 });
    expect(t.chat.map((x) => x.text)).not.toContain("Добрый вечер, сэр");
  });
});

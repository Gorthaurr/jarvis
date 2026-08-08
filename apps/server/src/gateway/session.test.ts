/**
 * Б4 (в) FAIL-FAST — session.sendAction в мёртвый сокет не висит таймаут, а мгновенно возвращает
 * channel_down (сессия жива в resume-grace, но сокет закрыт). Раньше команда ждала полный timeoutMs →
 * «задачи-зомби» жгли деньги/время. Плюс channelUp() как сигнал восстановления для петли (Б4 г).
 */
import { describe, expect, it } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { Session, type SessionSocket } from "./session.js";

const WS_OPEN = 1;
const WS_CLOSED = 3;

function sock(readyState = WS_OPEN): SessionSocket & { sent: string[]; readyState: number } {
  return { sent: [] as string[], readyState, send(d: string) { this.sent.push(d); }, close() {} };
}

const cmd: ActionCommand = { kind: "app.launch", app: "notepad" } as unknown as ActionCommand;

describe("Session.sendAction — fail-fast на мёртвом сокете (Б4 в)", () => {
  it("сокет закрыт (сессия жива) → мгновенный channel_down, БЕЗ ожидания таймаута", async () => {
    const s = new Session("sess-1", "u1", sock(WS_CLOSED));
    const started = Date.now();
    const res = await s.sendAction(cmd, 15_000);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("channel_down");
    expect(Date.now() - started).toBeLessThan(500); // не ждали 15с
    expect(s.inFlightCount).toBe(0); // не осталось висящей in-flight команды
  });

  it("сокет открыт → команда уходит и ждёт result (не channel_down сразу)", async () => {
    const socket = sock(WS_OPEN);
    const s = new Session("sess-2", "u1", socket);
    const p = s.sendAction(cmd, 15_000);
    expect(socket.sent.length).toBe(1); // команда реально отправлена
    expect(s.inFlightCount).toBe(1); // ждём ActionResult
    // Резолвим как клиент (иначе промис висит на unref-таймере).
    const env = JSON.parse(socket.sent[0]!) as { id: string };
    s.resolveAction({ commandId: env.id, ok: true, durationMs: 1 });
    const res = await p;
    expect(res.ok).toBe(true);
  });

  it("channelUp: true при открытом сокете, false после teardown", () => {
    const s = new Session("sess-3", "u1", sock(WS_OPEN));
    expect(s.channelUp()).toBe(true);
    s.teardown();
    expect(s.channelUp()).toBe(false); // сессия закрыта — канал не готов
  });

  it("channelUp: false при закрытом сокете живой сессии (resume-grace)", () => {
    const s = new Session("sess-4", "u1", sock(WS_CLOSED));
    expect(s.channelUp()).toBe(false);
  });
});

// Ф0 пульта: подтверждение §14 — «владелец отказал» и «я не смог его спросить» это РАЗНЫЕ вещи.
// До фикса вопрос уходил в мёртвый сокет молча, промис висел 60с (25% потолка задачи), и владельцу
// говорили «вы не подтвердили» про вопрос, которого он не видел.
describe("Session.requestConfirm — fail-fast и различимые исходы (Ф0)", () => {
  const req = (id = "r1") => ({ requestId: id, summary: "Отправить Кате?", kind: "send" as const, expiresAt: Date.now() + 60_000 });

  it("сокет закрыт → мгновенный undelivered, БЕЗ ожидания окна", async () => {
    const s = new Session("s1", "u1", sock(WS_CLOSED));
    const started = Date.now();
    const r = await s.requestConfirm(req());
    expect(r.approved).toBe(false);
    expect(r.outcome).toBe("undelivered"); // НЕ denied: владелец вопроса не видел
    expect(Date.now() - started).toBeLessThan(500); // окно 60с не сжигали
  });

  it("сокет открыт → вопрос уходит, решение владельца приходит как approved", async () => {
    const socket = sock(WS_OPEN);
    const s = new Session("s2", "u1", socket);
    const p = s.requestConfirm(req("r2"));
    expect(socket.sent.length).toBe(1); // вопрос реально отправлен
    s.resolveConfirm({ requestId: "r2", approved: true });
    const r = await p;
    expect(r.approved).toBe(true);
  });

  it("teardown резолвит НАСТОЯЩИМ requestId и undelivered (корреляция не теряется)", async () => {
    const s = new Session("s3", "u1", sock(WS_OPEN));
    const p = s.requestConfirm(req("r3"));
    s.teardown(); // сессия ушла, пока владелец думал
    const r = await p;
    expect(r.requestId).toBe("r3"); // раньше приходил пустой id — корреляция терялась
    expect(r.outcome).toBe("undelivered"); // и это не решение владельца
    expect(r.approved).toBe(false);
  });

  it("истечение окна = expired (владелец ВИДЕЛ вопрос, но не ответил) — мягче отказа", async () => {
    const s = new Session("s4", "u1", sock(WS_OPEN));
    const r = await s.requestConfirm({ requestId: "r4", summary: "?", kind: "send", expiresAt: Date.now() + 1 });
    expect(r.outcome).toBe("expired");
    expect(r.approved).toBe(false);
  });
});

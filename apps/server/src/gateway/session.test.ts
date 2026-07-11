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

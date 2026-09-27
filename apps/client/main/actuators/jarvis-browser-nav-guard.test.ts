/**
 * B-14 (rebinding): гард навигации сопоставляет блок пиннинг-прокси с ОТПУЩЕННЫМ им документом — так open()/read()
 * говорят «переход заблокирован», а не отдают страницу ошибки Chrome. Настоящий NavGuard, CDP — запись кадров.
 *
 * Реверт-проверки (из копии): `proxyBlocked` всегда false → «отпущенный документ» красный; порт по умолчанию не
 * подставлен (ключ `host:`) → «http 80 / https 443» красный; TTL не проверяется → «устаревший» красный.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpConn } from "./cdp-conn.js";
import { NavGuard } from "./jarvis-browser-nav-guard.js";

class FakeConn {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private readonly handlers = new Map<string, (p: Record<string, unknown>) => void>();
  dead = false;
  on(method: string, cb: (p: Record<string, unknown>) => void): () => void {
    this.handlers.set(method, cb);
    return () => this.handlers.delete(method);
  }
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    return {};
  }
  close(): void {
    this.dead = true;
  }
  paused(requestId: string, url: string, frameId: string): void {
    this.handlers.get("Fetch.requestPaused")?.({ requestId, frameId, request: { url } });
  }
}

/** Гард с «DNS», где всё публичное; документ отпущен (continueRequest ушёл). */
async function released(urls: Array<[string, string]>): Promise<{ guard: NavGuard; conn: FakeConn }> {
  const conn = new FakeConn();
  const guard = new NavGuard(conn as unknown as CdpConn, async () => ["203.0.113.10"]);
  await guard.start();
  urls.forEach(([url, frameId], i) => conn.paused(`r${i}`, url, frameId));
  await vi.waitFor(() => expect(conn.sent.filter((s) => s.method === "Fetch.continueRequest")).toHaveLength(urls.length));
  return { guard, conn };
}

afterEach(() => void vi.useRealTimers());

describe("B-14: блок пиннинг-прокси → запись журнала перехода", () => {
  it("отпущенный документ: блок на его host:port — запись с его кадром и причиной", async () => {
    const { guard } = await released([["http://shop.test:8080/page", "F1"]]);
    const mark = guard.mark();
    expect(guard.proxyBlocked({ host: "shop.test", port: 8080, reason: "private" })).toBe(true);
    expect(guard.since(mark)).toEqual([expect.objectContaining({ host: "shop.test", frameId: "F1", reason: "private" })]);
  });

  it("порт по схеме: http → 80, https → 443; IPv6-литерал — без скобок, как в записи прокси", async () => {
    const { guard } = await released([["http://a.test/", "F1"], ["https://b.test/x", "F2"], ["http://[2001:db8::1]:81/", "F3"]]);
    expect(guard.proxyBlocked({ host: "a.test", port: 80, reason: "private" })).toBe(true);
    expect(guard.proxyBlocked({ host: "b.test", port: 443, reason: "unresolved" })).toBe(true);
    expect(guard.proxyBlocked({ host: "2001:db8::1", port: 81, reason: "private" })).toBe(true);
    expect(guard.since(0).map((b) => [b.frameId, b.reason])).toEqual([["F1", "private"], ["F2", "unresolved"], ["F3", "private"]]);
  });

  it("подресурс (другой хост или порт, чем у отпущенного документа) — не переход: false, журнал пуст", async () => {
    const { guard } = await released([["http://shop.test/", "F1"]]);
    expect(guard.proxyBlocked({ host: "evil.test", port: 80, reason: "private" })).toBe(false);
    expect(guard.proxyBlocked({ host: "shop.test", port: 8080, reason: "private" })).toBe(false);
    expect(guard.since(0)).toEqual([]);
  });

  it("устаревший (дольше 15 с назад) документ не сопоставляется", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { guard } = await released([["http://shop.test/", "F1"]]);
    vi.setSystemTime(Date.now() + 16_000);
    expect(guard.proxyBlocked({ host: "shop.test", port: 80, reason: "private" })).toBe(false);
  });
});

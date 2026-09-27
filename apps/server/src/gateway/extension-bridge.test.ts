import { describe, expect, it, vi } from "vitest";
import { ExtensionBridge, type ExtSocket } from "./extension-bridge.js";
import { EXT_NO_REPLY, isExtNoReply } from "../brain/tools/ext-errors.js";

function fakeSocket() {
  const sent: string[] = [];
  const sock: ExtSocket = { send: (d) => sent.push(d), close: vi.fn() };
  return { sock, sent };
}

describe("ExtensionBridge (§6 руки в браузере)", () => {
  it("корреллирует ответ расширения по id", async () => {
    const b = new ExtensionBridge();
    const { sock, sent } = fakeSocket();
    b.attach(sock);
    expect(b.connected).toBe(true);

    const p = b.telegramSend("Катя", "люблю тебя");
    const sentMsg = JSON.parse(sent[0]!);
    expect(sentMsg.type).toBe("telegram.send");
    expect(sentMsg.to).toBe("Катя");
    // расширение отвечает успехом
    b.handleMessage(JSON.stringify({ id: sentMsg.id, ok: true, data: { ok: true, to: "Катя" } }));
    await expect(p).resolves.toEqual({ ok: true, to: "Катя" });
  });

  it("ошибку расширения пробрасывает как reject", async () => {
    const b = new ExtensionBridge();
    const { sock, sent } = fakeSocket();
    b.attach(sock);
    const p = b.request({ type: "telegram.send", to: "X", text: "y" });
    const id = JSON.parse(sent[0]!).id;
    b.handleMessage(JSON.stringify({ id, ok: false, error: "не нашёл контакт" }));
    await expect(p).rejects.toThrow("не нашёл контакт");
  });

  it("без подключения — сразу ошибка", async () => {
    const b = new ExtensionBridge();
    await expect(b.request({ type: "ping" })).rejects.toThrow("не подключено");
  });

  it("отключение отклоняет ожидающие запросы", async () => {
    const b = new ExtensionBridge();
    const { sock } = fakeSocket();
    b.attach(sock);
    const p = b.request({ type: "telegram.send", to: "X", text: "y" });
    b.detach(sock);
    expect(b.connected).toBe(false);
    await expect(p).rejects.toThrow("отключилось");
  });

  it("hello не ломает и не считается ответом", () => {
    const b = new ExtensionBridge();
    const { sock } = fakeSocket();
    b.attach(sock);
    expect(() => b.handleMessage(JSON.stringify({ type: "hello", agent: "x" }))).not.toThrow();
  });
});

// W1 (B-4, контракт §7): «ушло, ответа нет» отличимо от «не ушло» — от этого зависит, повторит ли модель клик/отправку.
describe("W1: мост различает «не ушло» и «ушло, ответа нет»; коды страницы в полях ошибки", () => {
  it("таймаут ПОСЛЕ отправки → ext_no_reply (исход неизвестен), а не обычная ошибка", async () => {
    vi.useFakeTimers();
    try {
      const b = new ExtensionBridge();
      const { sock } = fakeSocket();
      b.attach(sock);
      const p = b.request({ type: "tab.act" }, 1000).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1001);
      const e = await p;
      expect(isExtNoReply(e)).toBe(true);
      expect(String((e as Error).message)).toMatch(/не ответило/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it("отключение и переподключение с запросом в полёте → ext_no_reply", async () => {
    const b = new ExtensionBridge();
    const a = fakeSocket();
    b.attach(a.sock);
    const p1 = b.request({ type: "tab.act" }).catch((e: unknown) => e);
    b.attach(fakeSocket().sock); // вытеснение: старый сокет мог успеть нажать
    expect(isExtNoReply(await p1)).toBe(true);
    const c = fakeSocket();
    b.attach(c.sock);
    const p2 = b.request({ type: "tab.act" }).catch((e: unknown) => e);
    b.detach(c.sock);
    expect((await p2 as { code?: string }).code).toBe(EXT_NO_REPLY);
  });

  it("не подключено / socket.send бросил — запрос НЕ ушёл: обычный провал, НЕ ext_no_reply", async () => {
    const b = new ExtensionBridge();
    expect(isExtNoReply(await b.request({ type: "tab.act" }).catch((e: unknown) => e))).toBe(false);
    b.attach({ send: () => { throw new Error("сокет закрыт"); }, close: vi.fn() });
    const e = await b.request({ type: "tab.act" }).catch((x: unknown) => x);
    expect(String((e as Error).message)).toMatch(/сокет закрыт/u);
    expect(isExtNoReply(e)).toBe(false);
  });

  it("ответ {ok:false, error, code, label} → e.code и e.label (сервер не парсит текст нового расширения)", async () => {
    const b = new ExtensionBridge();
    const { sock, sent } = fakeSocket();
    b.attach(sock);
    const p = b.request({ type: "tab.act" }).catch((e: unknown) => e);
    const id = JSON.parse(sent[0]!).id;
    b.handleMessage(JSON.stringify({ id, ok: false, error: "commit_confirm: Оплатить", code: "commit_confirm", label: "Оплатить" }));
    const e = (await p) as { code?: string; label?: string; message: string };
    expect(e.code).toBe("commit_confirm");
    expect(e.label).toBe("Оплатить");
    expect(e.message).toBe("commit_confirm: Оплатить");
  });

  it("refMode:true уходит ВСЕГДА (флаг удалён; старое расширение без него не минтит ref)", () => {
    const b = new ExtensionBridge();
    const { sock, sent } = fakeSocket();
    b.attach(sock);
    void b.tabInspect("https://x.test", "кнопка", 20, 5).catch(() => {});
    void b.tabAct("https://x.test", "click", { ref: "e1_0" }, 5).catch(() => {});
    void b.tabBatch("https://x.test", [], 5).catch(() => {});
    const frames = sent.map((f) => JSON.parse(f) as { type: string; refMode?: unknown; tabId?: unknown });
    expect(frames.map((f) => f.type)).toEqual(["tab.inspect", "tab.act", "tab.batch"]);
    for (const f of frames) {
      expect(f.refMode, f.type).toBe(true);
      expect(f.tabId, f.type).toBe(5);
    }
  });

  it("tab.capture: rect/ref/scale уходят кадром; провал снимка данными {ok:false, code} — резолв, а не reject", async () => {
    const b = new ExtensionBridge();
    const { sock, sent } = fakeSocket();
    b.attach(sock);
    const p = b.tabCapture("https://x.test", 7, { rect: { x: 1, y: 2, w: 30, h: 40 }, scale: 2 });
    const f = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(f).toMatchObject({ type: "tab.capture", url: "https://x.test", tabId: 7, rect: { x: 1, y: 2, w: 30, h: 40 }, scale: 2 });
    b.handleMessage(JSON.stringify({ id: f.id, ok: true, data: { ok: false, code: "tab_not_visible", error: "вкладка не активна" } }));
    await expect(p).resolves.toEqual({ ok: false, code: "tab_not_visible", error: "вкладка не активна" });
  });
});

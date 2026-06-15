import { describe, expect, it, vi } from "vitest";
import { ExtensionBridge, type ExtSocket } from "./extension-bridge.js";

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

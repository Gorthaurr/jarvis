/**
 * B-14 (DNS) через НАСТОЯЩИЙ dispatchTool: имя, которое DNS отдаёт как 127.0.0.1 (localtest.me-класс, живой факт
 * 27.09), не уходит ни в невидимый браузер (web_*), ни в Chrome владельца (browser_open); отклонённый адрес не
 * становится «последней целью» web_act. Резолвер — таблица имён через ctx.resolveHost (без сети).
 *
 * Реверт-проверки (из копии): убрать navDnsRefusal из dispatch → web_open уходит клиенту → красный; вернуть
 * rememberWebTarget выше гарда → «последняя цель» = отклонённый URL → красный; убрать гейт из browser_open → красный.
 */
import { describe, expect, it } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { HostLookup } from "@jarvis/shared";
import { lastWebTarget } from "./commit-gate.js";
import { dispatchTool, type ToolContext } from "./dispatch.js";

const DNS: Record<string, string[]> = {
  "evil.example": ["127.0.0.1"],
  "mixed.example": ["203.0.113.10", "192.168.0.1"],
  "shop.example": ["203.0.113.10"],
};
const resolveHost: HostLookup = async (h) => {
  const v = DNS[h];
  if (!v) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
  return v;
};

function link() {
  const sent: ActionCommand[] = [];
  const sendAction = async (cmd: ActionCommand): Promise<ActionResult> => {
    sent.push(cmd);
    return { commandId: "c", ok: true, durationMs: 1, data: { title: "t", url: (cmd as { url?: string }).url ?? "", text: "ok" } };
  };
  const session = { sendAction };
  const ctx = { session, userId: "u1", resolveHost, confirm: async () => ({ approved: true, outcome: "approved" }) } as unknown as ToolContext;
  return { ctx, sent, session, tool: (name: string, input: Record<string, unknown>) => dispatchTool(name, input, ctx) };
}

describe("B-14 (DNS): навигация браузера по имени, указывающему внутрь", () => {
  it("web_open на имя → 127.0.0.1: честный отказ, клиенту НИЧЕГО не ушло", async () => {
    const l = link();
    const r = await l.tool("web_open", { url: "http://evil.example:8787/healthz" });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/evil\.example.*внутреннюю сеть \(127\.0\.0\.1\)/u);
    expect(l.sent).toEqual([]);
  });

  it("мультизапись «публичный + 192.168.0.1» → отказ; web_login (видимое окно входа без перехвата) — тоже", async () => {
    const l = link();
    for (const [tool, url] of [["web_open", "https://mixed.example/"], ["web_login", "https://evil.example/login"]] as const) {
      const r = await l.tool(tool, { url });
      expect(r.isError, tool).toBe(true);
    }
    expect(l.sent).toEqual([]);
  });

  it("отклонённый адрес НЕ становится «последней целью» web_act (раньше память цели стояла выше гарда)", async () => {
    const l = link();
    expect((await l.tool("web_open", { url: "https://shop.example/cart" })).isError).toBeFalsy();
    expect(lastWebTarget(l.session)).toBe("https://shop.example/cart");
    await l.tool("web_open", { url: "http://evil.example:8787/dev/say" });
    await l.tool("web_open", { url: "http://127.0.0.1:8787/healthz" }); // и отказ по имени — тоже
    expect(lastWebTarget(l.session)).toBe("https://shop.example/cart");
  });

  it("публичное имя уходит клиенту; не разрешившееся — тоже (сервер не подключается, суд — у браузера)", async () => {
    const l = link();
    await l.tool("web_open", { url: "https://shop.example/" });
    await l.tool("web_open", { url: "https://nx.example/" });
    expect(l.sent.map((c) => (c as { url?: string }).url)).toEqual(["https://shop.example/", "https://nx.example/"]);
  });

  it("browser_open (Chrome владельца) на имя → 127.0.0.1 — отказ, команда не ушла", async () => {
    const l = link();
    const r = await l.tool("browser_open", { url: "http://evil.example:8787/" });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/внутреннюю сеть/u);
    expect(l.sent).toEqual([]);
  });
});

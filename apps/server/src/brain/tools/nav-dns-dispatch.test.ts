/**
 * B-14 (DNS) через НАСТОЯЩИЙ dispatchTool: имя, которое DNS отдаёт как 127.0.0.1 (localtest.me-класс, живой факт
 * 27.09), не уходит ни в невидимый браузер (web_*), ни в Chrome владельца (browser_open); отклонённый адрес не
 * становится «последней целью» web_act. Резолвер — таблица имён через ctx.resolveHost (без сети).
 *
 * Реверт-проверки (из копии): убрать navDnsRefusal из dispatch → web_open уходит клиенту → красный; вернуть
 * rememberWebTarget выше гарда → «последняя цель» = отклонённый URL → красный; убрать гейт из browser_open → красный.
 */
import { describe, expect, it, vi } from "vitest";
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
  if (h === "slow.example") throw Object.assign(new Error("DNS не ответил"), { code: "ETIMEOUT" }); // как withTimeout
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

describe("B-14 (DNS), адверс-ревью: прочие пути к браузеру и честность текста", () => {
  it("DNS молчит (таймаут) → отказ и web_open, и browser_open (Chrome ждёт дольше нас — NS атакующего успел бы)", async () => {
    const l = link();
    for (const [tool, url] of [["web_open", "https://slow.example/"], ["browser_open", "http://slow.example:8787/"]] as const) {
      const r = await l.tool(tool, { url });
      expect(r.isError, tool).toBe(true);
      expect(String(r.content)).toMatch(/DNS не ответил/u);
    }
    expect(l.sent).toEqual([]);
  });

  it("input_batch с browser.open и app_launch{http} на имя → 127.0.0.1 — отказ, на клиент ничего (раньше гарда не было вовсе)", async () => {
    const l = link();
    const batch = await l.tool("input_batch", { steps: [{ action: "browser.open", params: { url: "http://evil.example:8787/healthz" } }] });
    expect(batch.isError).toBe(true);
    expect(String(batch.content)).toMatch(/внутреннюю сеть/u);
    const launch = await l.tool("app_launch", { app: "http://evil.example:8787/" });
    expect(launch.isError).toBe(true);
    expect(l.sent).toEqual([]);
  });

  it("skill_execute: навык (его могла записать модель) с browser.open на имя → 127.0.0.1 — отказ до клиента", async () => {
    const skill = { id: "sk1", name: "открыть", version: 1, steps: [{ action: "browser.open", params: { url: "evil.example:8787/dev/say" } }] };
    const l = link();
    const ctx = { ...l.ctx, skills: { get: vi.fn(async () => skill), list: vi.fn(async () => [skill]) } } as unknown as ToolContext;
    const r = await dispatchTool("skill_execute", { skillId: "sk1" }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/внутреннюю сеть/u);
    expect(l.sent).toEqual([]);
  });

  it("watch_create с predicate.url на имя → 127.0.0.1 — отказ (self-heal переоткрывал бы его в Chrome владельца)", async () => {
    const add = vi.fn(() => ({ ok: true, id: "w1" }));
    const ctx = { ...link().ctx, sessionId: "s1", watch: { add } } as unknown as ToolContext;
    const r = await dispatchTool("watch_create", { what: "видео", condition: "дошло", predicate: { kind: "browser", value: 10, url: "http://evil.example:8787/" } }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/внутреннюю сеть/u);
    expect(add).not.toHaveBeenCalled();
  });

  it("browser_read вкладки владельца на имени → 127.0.0.1 — содержимое модели не отдаём", async () => {
    const tabRead = vi.fn(async () => ({ url: "http://evil.example:8787/admin", title: "Router", text: "ROUTER-SECRET" }));
    const ext = { connected: true, tabRead, tabList: vi.fn(async () => ({ tabs: [], count: 0 })), openOrFocus: vi.fn(async () => ({ tabId: 1 })) };
    const ctx = { ...link().ctx, ext } as unknown as ToolContext;
    expect((await dispatchTool("browser_open", { url: "https://shop.example/" }, ctx)).isError).toBeFalsy(); // публичный
    const r = await dispatchTool("browser_read", {}, ctx); // а страница увела вкладку на имя → 127.0.0.1
    expect(tabRead).toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(String(r.content)).not.toContain("ROUTER-SECRET");
  });

  it("web_act: блок по DNS (unresolved) — честный «не выполнен», а не ложное «внутренний адрес»", async () => {
    const reply = (reason: string) => async (): Promise<ActionResult> => ({ commandId: "c", ok: true, durationMs: 1, data: { ok: true, changed: true, blockedNav: "…", blockedNavReason: reason } });
    for (const [reason, re] of [["unresolved", /не прошёл проверку DNS/u], ["private", /внутренний адрес ЗАБЛОКИРОВАН/u]] as const) {
      const ctx = { ...link().ctx, session: { sendAction: reply(reason) } } as unknown as ToolContext;
      const r = await dispatchTool("web_act", { intent: "click", params: { selector: "#go" } }, ctx);
      expect(String(r.content), reason).toMatch(re);
    }
    const ctx = { ...link().ctx, session: { sendAction: reply("unresolved") } } as unknown as ToolContext;
    expect(String((await dispatchTool("web_act", { intent: "click", params: { selector: "#go" } }, ctx)).content)).not.toMatch(/внутренний адрес/u);
  });
});

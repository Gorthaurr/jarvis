/**
 * Стенд: сокет bench-сессии отвечает на §14 по политике вызова (НАСТОЯЩИЙ Session.requestConfirm/sendAction).
 * Реверт-проверка: ответ «no» → approved:true в BenchSocket — падает «нет → отказ»; ответ без AsyncLocalStorage
 * (политика глобальная) — падает «сирота».
 */
import { describe, expect, it } from "vitest";
import { Session } from "../session.js";
import { BenchSocket, benchCall, newBenchCall, parsePolicy } from "./bench-socket.js";

function setup() {
  const sock = new BenchSocket();
  const session = new Session("s-bench", "u1", sock);
  sock.bind(session);
  const ask = (summary = "Оплатить?") =>
    session.requestConfirm({ requestId: `r-${Math.random()}`, summary, kind: "irreversible", expiresAt: Date.now() + 60_000 });
  return { sock, session, ask };
}

describe("BenchSocket: §14-ответы по политике вызова", () => {
  it("yes → approved, вопрос записан", async () => {
    const { ask } = setup();
    const call = newBenchCall("yes");
    const r = await benchCall.run(call, () => ask("Оплатить 100 ₽?"));
    expect(r.approved).toBe(true);
    expect(call.questions).toHaveLength(1);
    expect(call.questions[0]).toMatchObject({ n: 1, answer: "yes", outcome: "approved", summary: "Оплатить 100 ₽?" });
  });

  it("no → НЕ approved (отказ владельца)", async () => {
    const { ask } = setup();
    const call = newBenchCall("no");
    const r = await benchCall.run(call, () => ask());
    expect(r.approved).toBe(false);
    expect(r.outcome).toBeUndefined(); // осознанное решение — outcome выводит ToolContext
    expect(call.questions[0]?.outcome).toBe("denied");
  });

  it("массив: по ответу на вопрос, дальше — отказоустойчивое «нет» с overflow", async () => {
    const { ask } = setup();
    const call = newBenchCall(["yes", "no"]);
    const rs = await benchCall.run(call, async () => [await ask("1"), await ask("2"), await ask("3")]);
    expect(rs.map((r) => r.approved)).toEqual([true, false, false]);
    expect(call.questions.map((q) => q.overflow === true)).toEqual([false, false, true]);
  });

  it("expire / undelivered → различимые исходы", async () => {
    const { ask } = setup();
    const e = await benchCall.run(newBenchCall("expire"), () => ask());
    const u = await benchCall.run(newBenchCall("undelivered"), () => ask());
    expect(e).toMatchObject({ approved: false, outcome: "expired" });
    expect(u).toMatchObject({ approved: false, outcome: "undelivered" });
  });

  it("вопрос вне живого вызова (сирота фоновой задачи) → «нет» + stray, в чужой вызов не пишется", async () => {
    const { ask, sock } = setup();
    const call = newBenchCall("yes");
    call.done = true; // вызов уже вернул ответ
    const r = await benchCall.run(call, () => ask("поздний вопрос"));
    expect(r.approved).toBe(false);
    expect(call.questions).toHaveLength(0);
    expect(sock.stray.map((s) => s.summary)).toEqual(["поздний вопрос"]);
    const r2 = await ask("совсем без вызова");
    expect(r2.approved).toBe(false);
    expect(sock.stray).toHaveLength(2);
  });

  it("action.command клиенту ПК → честный отказ runtime (не фейковый ok), учтён в вызове", async () => {
    const { session } = setup();
    const call = newBenchCall("no");
    const r = await benchCall.run(call, () => session.sendAction({ kind: "browser.open", url: "https://x.example.com" } as never, 5_000));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("runtime");
    expect(call.clientActions.map((a) => a.kind)).toEqual(["browser.open"]);
  });

  it("кадры копятся в вызове; после close сокет закрыт для Session", () => {
    const { session, sock } = setup();
    const call = newBenchCall("no");
    benchCall.run(call, () => session.send("chat", { role: "assistant", text: "Готово" }));
    expect(call.frames.map((f) => f.type)).toEqual(["chat"]);
    sock.close();
    expect(session.channelUp()).toBe(false);
  });

  it("parsePolicy: строка, список через запятую, массив, мусор", () => {
    expect(parsePolicy(undefined)).toBe("no");
    expect(parsePolicy("yes")).toBe("yes");
    expect(parsePolicy("yes,no")).toEqual(["yes", "no"]);
    expect(parsePolicy(["no", "yes"])).toEqual(["no", "yes"]);
    expect(parsePolicy("maybe")).toBeNull();
  });
});

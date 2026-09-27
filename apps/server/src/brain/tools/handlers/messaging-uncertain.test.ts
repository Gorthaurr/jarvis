/**
 * W2 П3 (S-7) — ТРИ исхода отправки (закон 1) через НАСТОЯЩИЙ dispatchTool: таймаут/разрыв сессии после отправки
 * message_send и «расширение не ответило» у голосового — это «не знаю, ушло ли» (`uncertain`), а не «не отправлено».
 * Повтор того же текста — только через вопрос владельцу («может прийти дублем»), без молчаливого дубля и без
 * молчаливого «уже отправлял» про непроверенную отправку.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { type ToolContext, dispatchTool } from "../dispatch.js";
import { extNoReplyError } from "../ext-errors.js";
import { _resetResendGuardForTest } from "./messaging.js";

type Answer = { approved: boolean; outcome: "approved" | "denied" };

function setup(results: ActionResult["error"][], answers: boolean[] = [true, true]) {
  const sent: ActionCommand[] = [];
  let i = 0;
  const sendAction = vi.fn(async (cmd: ActionCommand): Promise<ActionResult> => {
    sent.push(cmd);
    const error = results[i++];
    return error ? { commandId: "c", ok: false, error, durationMs: 1 } : { commandId: "c", ok: true, durationMs: 1 };
  });
  let a = 0;
  const confirm = vi.fn(async (_s: string): Promise<Answer> => {
    const approved = answers[a++] ?? true;
    return { approved, outcome: approved ? "approved" : "denied" };
  });
  const ctx = { session: { sendAction }, userId: `u-${Math.random().toString(36).slice(2)}`, confirm } as unknown as ToolContext;
  return { ctx, sent, confirm };
}

afterEach(() => {
  vi.useRealTimers();
  _resetResendGuardForTest();
});

/**
 * Дождаться промиса под фейковыми часами (как messaging.test.ts): sendOutbound спит «человеческий конверт», таймер
 * которого планируется после реального IO (запись согласия) — двигаем часы и уступаем настоящему циклу по очереди.
 */
const realSetTimeout = globalThis.setTimeout;
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  let out: T | undefined;
  void p.then((v) => {
    done = true;
    out = v;
  });
  for (let i = 0; i < 200 && !done; i += 1) {
    await vi.advanceTimersByTimeAsync(500);
    await new Promise<void>((r) => realSetTimeout(r, 1));
  }
  if (!done) throw new Error("settle: промис не резолвился под фейковыми часами");
  return out as T;
}

const TIMEOUT = { code: "timeout" as const, message: "нет result за 15000ms" };

describe("message_send: таймаут/разрыв после отправки → uncertain; повтор — через вопрос", () => {
  it("таймаут → uncertain (не sent, не «не отправлено»); повтор того же текста → вопрос «оборвалась» → уходит", async () => {
    vi.useFakeTimers();
    const s = setup([TIMEOUT]);
    const r1 = await settle(dispatchTool("message_send", { channel: "vk", to: "Катя", body: "буду в семь" }, s.ctx));
    expect(r1.uncertain).toBe(true);
    expect(r1.sent).toBeUndefined();
    expect(String(r1.content)).toMatch(/Не знаю, ушло ли сообщение «Катя»/u);
    expect(s.confirm).toHaveBeenCalledTimes(1); // первый — обычное согласие на адресата
    await vi.advanceTimersByTimeAsync(4_000); // за анти-burst (cadence учёл возможную отправку)
    const r2 = await settle(dispatchTool("message_send", { channel: "vk", to: "Катя", body: "буду в семь" }, s.ctx));
    expect(s.confirm).toHaveBeenCalledTimes(2);
    expect(String(s.confirm.mock.calls[1]![0])).toMatch(/оборвалась.*не знаю, дошла ли/su);
    expect(r2.sent).toBe(true);
    expect(s.sent.filter((c) => c.kind === "message.send")).toHaveLength(2);
  });

  it("владелец отказал в повторе → declined, второй отправки нет; разрыв сессии (disconnected) — тоже uncertain", async () => {
    vi.useFakeTimers();
    const s = setup([{ code: "disconnected", message: "сессия закрыта" }], [true, false]);
    const r1 = await settle(dispatchTool("message_send", { channel: "telegram", to: "Маша", body: "ок" }, s.ctx));
    expect(r1.uncertain).toBe(true);
    expect(String(r1.content)).toMatch(/telegram_read «Маша»/u);
    await vi.advanceTimersByTimeAsync(4_000);
    const r2 = await settle(dispatchTool("message_send", { channel: "telegram", to: "Маша", body: "ок" }, s.ctx));
    expect(r2.declined).toBe(true);
    expect(s.sent.filter((c) => c.kind === "message.send")).toHaveLength(1);
  });

  it("ошибка клиента (runtime) — по-прежнему честное «не отправлено», не uncertain", async () => {
    vi.useFakeTimers();
    const s = setup([{ code: "runtime", message: "userbot не залогинен" }]);
    const r = await settle(dispatchTool("message_send", { channel: "vk", to: "Петя", body: "привет" }, s.ctx));
    expect(r.isError).toBe(true);
    expect(r.uncertain).toBeUndefined();
  });
});

describe("telegram_send_voice: расширение не ответило → uncertain; повтор — через вопрос", () => {
  it("ext_no_reply → uncertain; повтор того же текста → вопрос «оборвалась», одобрено → второе голосовое", async () => {
    vi.useFakeTimers();
    const s = setup([]);
    const sendVoice = vi.fn().mockRejectedValueOnce(extNoReplyError("расширение не ответило за 90000мс")).mockResolvedValue({ ok: true });
    Object.assign(s.ctx, { synthVoice: async () => "bXAz", telegramSendVoice: sendVoice });
    const r1 = await dispatchTool("telegram_send_voice", { to: "Катя", text: "с днём рождения" }, s.ctx);
    expect(r1.uncertain).toBe(true);
    expect(String(r1.content)).toMatch(/Не знаю, ушло ли голосовое/u);
    vi.advanceTimersByTime(4_000); // за анти-burst: возможная отправка учтена в частоте
    const r2 = await dispatchTool("telegram_send_voice", { to: "Катя", text: "с днём рождения" }, s.ctx);
    expect(String(s.confirm.mock.calls.at(-1)![0])).toMatch(/оборвалась.*ГОЛОСОВОЕ ещё раз/su);
    expect(r2.sent).toBe(true);
    expect(sendVoice).toHaveBeenCalledTimes(2);
  });
});

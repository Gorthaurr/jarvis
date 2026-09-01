/**
 * ЖИВОЙ ЭПИЗОД (2026-08-31): «Катя получила одно и то же дважды». Отправка вернула ошибку (истёк
 * таймаут действия), хотя сообщение ушло; сервер пошёл фолбэком через расширение и отправил второе.
 * Тесты гоняют РЕАЛЬНЫЙ telegramSend против моков транспорта — проверяем, что перед повтором мы
 * СМОТРИМ чат и что неопределённость не превращается ни в дубль, ни в ложный отчёт.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { ActuatorSink, ToolContext } from "../dispatch.js";
import { _resetResendGuardForTest, telegramSend } from "./messaging.js";

const TIMED_OUT: ActionResult = { commandId: "c", durationMs: 90_000, ok: false, error: { code: "timeout", message: "нет result за 90000ms" } };

/** Транспорт: отправка всегда падает по таймауту, чтение чата отвечает по сценарию. */
function ctxWith(readback: () => Promise<ActionResult>, over: Partial<ToolContext> = {}) {
  const sendAction = vi.fn(async (cmd: ActionCommand): Promise<ActionResult> => (cmd.kind === "telegram.read" ? readback() : TIMED_OUT));
  const session: ActuatorSink = { sendAction: sendAction as ActuatorSink["sendAction"] };
  const ctx = {
    session,
    web: {} as ToolContext["web"],
    episodic: {} as ToolContext["episodic"],
    userId: `u-${Math.random().toString(36).slice(2)}`,
    confirm: async () => ({ approved: true, outcome: "approved" as const }),
    ...over,
  } as ToolContext;
  return { ctx, sendAction };
}

const readOk = (messages: unknown): ActionResult => ({ commandId: "r", durationMs: 5, ok: true, data: { chatTitle: "Катя", messages } });

describe("telegram_send: неопределённый исход сверяется чтением чата", () => {
  it("сообщение УШЛО (видно в чате) → честный успех, фолбэк-расширение НЕ дёргается", async () => {
    _resetResendGuardForTest();
    const fallback = vi.fn(async () => ({ chatTitle: "Катя" }));
    const { ctx, sendAction } = ctxWith(async () => readOk([{ dir: "out", text: "буду через час" }]), {
      telegramSend: fallback as unknown as ToolContext["telegramSend"],
    });

    const r = await telegramSend(ctx, { to: "Катя", text: "буду через час" });

    expect(r.isError).toBe(false);
    expect(r.sent).toBe(true); // отправка СОСТОЯЛАСЬ — петля не должна считать ход провалом
    expect(String(r.content)).toMatch(/видно в чате/);
    expect(fallback).not.toHaveBeenCalled(); // ← корень дубля: второй отправитель не запускается
    expect(sendAction).toHaveBeenCalledTimes(2); // send + read-back
  });

  it("сообщения в чате НЕТ → отправка действительно не прошла, фолбэк законен", async () => {
    _resetResendGuardForTest();
    const fallback = vi.fn(async () => ({ chatTitle: "Катя" }));
    const { ctx } = ctxWith(async () => readOk([{ dir: "in", text: "ты где?" }]), {
      telegramSend: fallback as unknown as ToolContext["telegramSend"],
    });

    const r = await telegramSend(ctx, { to: "Катя", text: "буду через час" });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(true);
    expect(String(r.content)).toMatch(/через расширение/);
  });

  it("чат прочитать не удалось → НЕ повторяем вслепую и НЕ рапортуем успех", async () => {
    _resetResendGuardForTest();
    const fallback = vi.fn(async () => ({ chatTitle: "Катя" }));
    const { ctx } = ctxWith(async () => TIMED_OUT, { telegramSend: fallback as unknown as ToolContext["telegramSend"] });

    const r = await telegramSend(ctx, { to: "Катя", text: "буду через час" });

    expect(fallback).not.toHaveBeenCalled(); // дубль человеку необратим — вслепую не шлём
    expect(r.isError).toBe(true);
    expect(r.sent).toBeUndefined(); // и успехом это не притворяется
    expect(String(r.content)).toMatch(/Не знаю, ушло ли/);
    expect(String(r.content)).toMatch(/telegram_read/); // модели сказано, чем проверить
  });

  it("после неопределённого исхода повтор не уходит молча — и не врёт «уже отправлял»", async () => {
    _resetResendGuardForTest();
    const { ctx, sendAction } = ctxWith(async () => TIMED_OUT);

    await telegramSend(ctx, { to: "Катя", text: "буду через час" });
    const callsAfterFirst = sendAction.mock.calls.length;
    const second = await telegramSend(ctx, { to: "Катя", text: "буду через час" });

    expect(sendAction.mock.calls.length).toBe(callsAfterFirst); // вторая отправка в транспорт не пошла
    expect(String(second.content)).toMatch(/Не знаю, ушло ли/); // ← не «уже отправлял»: это непроверенное утверждение
    expect(String(second.content)).toMatch(/resend:true/);
  });

  it("channel_down: команда не ушла с сервера — сверять нечем, лишнего чтения нет", async () => {
    _resetResendGuardForTest();
    const down: ActionResult = { commandId: "c", durationMs: 0, ok: false, error: { code: "channel_down", message: "канал недоступен" } };
    const sendAction = vi.fn(async (): Promise<ActionResult> => down);
    const ctx = {
      session: { sendAction } as ActuatorSink,
      web: {} as ToolContext["web"],
      episodic: {} as ToolContext["episodic"],
      userId: `u-${Math.random().toString(36).slice(2)}`,
      confirm: async () => ({ approved: true, outcome: "approved" as const }),
    } as ToolContext;

    const r = await telegramSend(ctx, { to: "Катя", text: "буду через час" });

    expect(sendAction).toHaveBeenCalledTimes(1); // read-back по мёртвому каналу не делаем
    expect(r.channelDown).toBe(true);
  });
});

describe("неопределённость доходит до ПАМЯТИ о сделанном (журнал прерванной задачи)", () => {
  it("помечает результат как uncertain — иначе журнал скажет «ОШИБКА» и продолжение повторит отправку", async () => {
    _resetResendGuardForTest();
    const { ctx } = ctxWith(async () => TIMED_OUT);
    const r = await telegramSend(ctx, { to: "Катя", text: "буду через час" });
    expect(r.isError).toBe(true);
    expect(r.uncertain).toBe(true);
  });

  it("журнал пишет «сверь перед повтором», а не «не сделано»", async () => {
    const { buildResumeDigest } = await import("../../agent/checkpoint.js");
    const convo = [
      { role: "assistant" as const, content: [{ type: "tool_use", id: "u1", name: "telegram_send", input: { to: "Катя", text: "буду" } }] },
      { role: "user" as const, content: [{ type: "tool_result", tool_use_id: "u1", is_error: true, content: "Не знаю, ушло ли" }] },
    ];
    const digest = buildResumeDigest(convo as never, { uncertainCalls: new Set(["u1"]) });
    expect(digest).toMatch(/ИСХОД НЕИЗВЕСТЕН/);
    expect(digest).toMatch(/СВЕРЬ/);
  });
});

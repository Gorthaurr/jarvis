import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@jarvis/protocol";
import type { ActuatorSink, ToolContext } from "../dispatch.js";
import { telegramSend } from "./messaging.js";

/** Минимальный ToolContext для telegram_send: confirm всегда approve, session мокается по кейсу. */
function baseCtx(over: Partial<ToolContext> = {}): ToolContext {
  const session: ActuatorSink = {
    sendAction: vi.fn(
      async (): Promise<ActionResult> => ({ commandId: "c1", durationMs: 1, ok: true, data: { chatTitle: "Маша" } }),
    ),
  };
  return {
    session,
    web: {} as ToolContext["web"],
    episodic: {} as ToolContext["episodic"],
    userId: `u-${Math.random().toString(36).slice(2)}`, // §14 confirm-once персистентен по userId — изолируем тесты
    confirm: async () => ({ approved: true }),
    ...over,
  } as ToolContext;
}

describe("telegramSend — cadence + идемпотентность (M6)", () => {
  it("happy path: отправляет и запоминает ключ идемпотентности", async () => {
    const ctx = baseCtx();
    const r = await telegramSend(ctx, { to: "@masha", text: "буду в 7" });
    expect(r.isError).toBe(false);
    expect(ctx.session.sendAction).toHaveBeenCalledTimes(1);
  });

  it("retry после таймаута (тот же to+text) не шлёт дубль — идемпотентность как у message_send", async () => {
    // Module-level CadenceGuard в messaging.ts живёт на реальном Date.now() — отводим часы вперёд
    // за anti-burst окно (DEFAULT_CADENCE.minGapMs), чтобы ретрай не упёрся в cadence РАНЬШЕ, чем
    // в проверку идемпотентности (тот же порядок гардов, что у message_send/sendOutbound).
    vi.useFakeTimers();
    try {
      const ctx = baseCtx();
      const r1 = await telegramSend(ctx, { to: "@masha2", text: "буду в 8" });
      expect(r1.isError).toBe(false);
      expect(ctx.session.sendAction).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(4_000); // > minGapMs(3000), но внутри окна учёта (windowMs=60000)

      // Агент повторяет вызов с теми же аргументами (симуляция ретрая после таймаута).
      const r2 = await telegramSend(ctx, { to: "@masha2", text: "буду в 8" });
      expect(r2.isError).toBe(false);
      expect(ctx.session.sendAction).toHaveBeenCalledTimes(1); // второй раз транспорт НЕ дёрнулся
    } finally {
      vi.useRealTimers();
    }
  });

  it("другой текст другому адресату — свой ключ, отправляется отдельно (не путается с идемпотентностью)", async () => {
    vi.useFakeTimers();
    try {
      const ctx = baseCtx();
      await telegramSend(ctx, { to: "@masha3", text: "буду в 7" });
      vi.advanceTimersByTime(4_000); // > anti-burst minGapMs (per-channel, не per-recipient)
      await telegramSend(ctx, { to: "@masha4", text: "буду в 8" });
      expect(ctx.session.sendAction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cadence блокирует burst — как у message_send, без похода в транспорт", async () => {
    const ctx = baseCtx();
    // Первая отправка проходит; тут же вторая (другой текст, тот же адресат) упирается в
    // минимальный человеческий интервал (anti-burst, DEFAULT_CADENCE.minGapMs) — тест гоняется мгновенно.
    const r1 = await telegramSend(ctx, { to: "@burst", text: "1" });
    expect(r1.isError).toBe(false);
    const r2 = await telegramSend(ctx, { to: "@burst", text: "2" });
    expect(r2.isError).toBe(true);
    expect(String(r2.content)).toMatch(/cadence-лимит/);
    expect(ctx.session.sendAction).toHaveBeenCalledTimes(1); // до транспорта вторая не дошла
  });

  // Интеграционное ревью (#2): channel_down (мёртвый сокет в resume-grace) → ToolResult.channelDown=true,
  // чтобы петля ЖДАЛА reconnect, а не эскалировала тир («Opus от транспорта»). Нет фолбэка расширения.
  it("(#2) channel_down без фолбэка → помечает channelDown (петля ждёт reconnect, не эскалирует)", async () => {
    const session: ActuatorSink = {
      sendAction: vi.fn(async (): Promise<ActionResult> => ({ commandId: "c", durationMs: 0, ok: false, error: { code: "channel_down", message: "канал недоступен" } })),
    };
    const ctx = baseCtx({ session });
    const r = await telegramSend(ctx, { to: "@x", text: "привет" });
    expect(r.isError).toBe(true);
    expect(r.channelDown).toBe(true); // не обычная ошибка — сигнал петле ждать reconnect
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@jarvis/protocol";
import type { ActuatorSink, ToolContext } from "../dispatch.js";
import { messageSend, telegramSend, telegramSendVoiceHandler } from "./messaging.js";

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
    expect(r.sent).toBe(true); // РЕАЛЬНАЯ отправка — петля пометит задачу outboundSend
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

/** Сессия, отвечающая как живой клиент: чат резолвится в «Катя Любимая» с peerId 42. */
function katyaSession(): ActuatorSink {
  return {
    sendAction: vi.fn(
      async (): Promise<ActionResult> => ({ commandId: "c1", durationMs: 1, ok: true, data: { chatTitle: "Катя Любимая", peerId: "42" } }),
    ),
  };
}

/** Опытная память резолва: любое написание «кати» ведёт к одному peerId (как в живом эпизоде). */
function katyaResolution(): ToolContext["resolutionMemory"] {
  return {
    recall: () => ({ peerId: "42", title: "Катя Любимая" }),
    remember: vi.fn(),
    forget: vi.fn(),
  } as unknown as ToolContext["resolutionMemory"];
}

describe("telegramSend — ресенд-гард (эпизод «двойная отправка Кате» 2026-07-24)", () => {
  it("живой эпизод: повтор того же текста через 12с ДРУГИМ написанием имени → второй раз НЕ уходит", async () => {
    vi.useFakeTimers();
    try {
      const session = katyaSession();
      const ctx = baseCtx({ session, resolutionMemory: katyaResolution() });
      const r1 = await telegramSend(ctx, { to: "Катя", text: "Я люблю тебя" });
      expect(r1.isError).toBe(false);
      expect(session.sendAction).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(12_000); // ровно как в логе: 14:44:32 → 14:44:44

      // Вторая петля шлёт «Кате» (склонение!) с другой пунктуацией — точный дедуп это пропускал.
      const r2 = await telegramSend(ctx, { to: "Кате", text: "я люблю тебя." });
      expect(r2.isError).toBe(false);
      expect(r2.sent).toBeUndefined(); // честный отказ ≠ отправка — outboundSend НЕ пометится
      expect(session.sendAction).toHaveBeenCalledTimes(1); // дубль человеку НЕ ушёл
      expect(String(r2.content)).toMatch(/повтор НЕ ушёл/i);
      expect(String(r2.content)).toMatch(/resend:true/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("похожий (не идентичный) текст тому же адресату в окне → уходит ТОЛЬКО через confirm", async () => {
    vi.useFakeTimers();
    try {
      const session = katyaSession();
      const confirm = vi.fn(async (_summary: string, _kind?: string) => ({ approved: true }));
      const ctx = baseCtx({ session, confirm, resolutionMemory: katyaResolution() });
      await telegramSend(ctx, { to: "Катя", text: "я люблю тебя" });
      vi.advanceTimersByTime(12_000);

      const r2 = await telegramSend(ctx, { to: "Катя", text: "люблю тебя ❤️" });
      expect(r2.isError).toBe(false);
      expect(session.sendAction).toHaveBeenCalledTimes(2); // подтверждено → ушло
      const lastConfirm = confirm.mock.calls.at(-1);
      expect(String(lastConfirm?.[0])).toMatch(/только что/);
      expect(lastConfirm?.[1]).toBe("send");
    } finally {
      vi.useRealTimers();
    }
  });

  it("похожий текст, владелец НЕ подтвердил → честное «не отправил», транспорт не дёргался", async () => {
    vi.useFakeTimers();
    try {
      const session = katyaSession();
      // Первую отправку (consent адресата) одобряем, повтор-вдогонку — нет.
      const confirm = vi.fn(async () => ({ approved: confirm.mock.calls.length <= 1 }));
      const ctx = baseCtx({ session, confirm, resolutionMemory: katyaResolution() });
      await telegramSend(ctx, { to: "Катя", text: "я люблю тебя" });
      vi.advanceTimersByTime(12_000);

      const r2 = await telegramSend(ctx, { to: "Катя", text: "люблю тебя ❤️" });
      expect(r2.isError).toBe(false);
      expect(r2.sent).toBeUndefined(); // «вы не подтвердили» ≠ отправка
      expect(String(r2.content)).toMatch(/не подтвердили/);
      expect(session.sendAction).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ЯВНЫЙ повтор (resend:true) идентичного текста → confirm → уходит", async () => {
    vi.useFakeTimers();
    try {
      const session = katyaSession();
      const confirm = vi.fn(async (_summary: string, _kind?: string) => ({ approved: true }));
      const ctx = baseCtx({ session, confirm, resolutionMemory: katyaResolution() });
      await telegramSend(ctx, { to: "Катя", text: "я люблю тебя" });
      vi.advanceTimersByTime(12_000);

      const r2 = await telegramSend(ctx, { to: "Катя", text: "я люблю тебя", resend: true });
      expect(r2.isError).toBe(false);
      expect(session.sendAction).toHaveBeenCalledTimes(2); // подтверждённый повтор ушёл
      expect(String(confirm.mock.calls.at(-1)?.[0])).toMatch(/Повторная отправка/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("разное содержание тому же адресату («вдогонку» с новым смыслом) → уходит без лишнего confirm", async () => {
    vi.useFakeTimers();
    try {
      const session = katyaSession();
      const confirm = vi.fn(async () => ({ approved: true }));
      const ctx = baseCtx({ session, confirm, resolutionMemory: katyaResolution() });
      await telegramSend(ctx, { to: "Катя", text: "приду в восемь" });
      const confirmsAfterFirst = confirm.mock.calls.length; // consent нового адресата
      vi.advanceTimersByTime(12_000);

      const r2 = await telegramSend(ctx, { to: "Катя", text: "и куплю хлеб по пути" });
      expect(r2.isError).toBe(false);
      expect(session.sendAction).toHaveBeenCalledTimes(2);
      expect(confirm.mock.calls.length).toBe(confirmsAfterFirst); // ресенд-гейт confirm НЕ добавил
    } finally {
      vi.useRealTimers();
    }
  });

  it("ТЁЗКА с явным peer: то же сообщение ДРУГОЙ Кате уходит свободно (ключи по идентичности, ревью)", async () => {
    vi.useFakeTimers();
    try {
      const session = katyaSession(); // резолвится в Катю A (peerId 42)
      const ctx = baseCtx({ session, confirm: async () => ({ approved: true }), resolutionMemory: katyaResolution() });
      const r1 = await telegramSend(ctx, { to: "Катя", text: "привет" });
      expect(r1.sent).toBe(true);
      vi.advanceTimersByTime(12_000);

      // Владелец выбрал из тёзок ДРУГУЮ Катю (peer B) — это НЕ повтор той же отправки.
      const r2 = await telegramSend(ctx, { to: "Катя", peer: "B", text: "привет" });
      expect(r2.isError).toBe(false);
      expect(r2.sent).toBe(true); // ушло, «повтор НЕ ушёл» об окно Кати A не билось
      expect(session.sendAction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("повтор в окне при НЕдоступном канале подтверждения (resend:true) → честный отказ, не отправка", async () => {
    vi.useFakeTimers();
    try {
      const session = katyaSession();
      const ctx = baseCtx({ session, resolutionMemory: katyaResolution() });
      await telegramSend(ctx, { to: "Катя", text: "я люблю тебя" });
      vi.advanceTimersByTime(12_000);
      const noConfirm = { ...ctx, confirm: undefined } as ToolContext;
      const r2 = await telegramSend(noConfirm, { to: "Катя", text: "я люблю тебя", resend: true });
      expect(r2.isError).toBe(true); // fail-closed (§14)
      expect(session.sendAction).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("telegramSendVoiceHandler — голосовое в тех же гардах (дыра того же класса)", () => {
  it("текст только что ушёл этому адресату → голосовое-повтор требует confirm", async () => {
    vi.useFakeTimers();
    try {
      const session = katyaSession();
      const confirm = vi.fn(async (_summary: string, _kind?: string) => ({ approved: true }));
      const telegramSendVoice = vi.fn(async () => undefined);
      const ctx = baseCtx({
        session,
        confirm,
        resolutionMemory: katyaResolution(),
        synthVoice: async () => "bXAz",
        telegramSendVoice,
      });
      await telegramSend(ctx, { to: "Катя", text: "я люблю тебя" });
      vi.advanceTimersByTime(12_000);

      const r2 = await telegramSendVoiceHandler(ctx, { to: "Катя", text: "я люблю тебя" });
      expect(r2.isError).toBe(false);
      expect(telegramSendVoice).toHaveBeenCalledTimes(1); // подтверждено → ушло
      expect(String(confirm.mock.calls.at(-1)?.[0])).toMatch(/ГОЛОСОВОЕ/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("messageSend — ресенд-гард (симметрия с telegram_send)", () => {
  function msgSession(): ActuatorSink {
    return {
      sendAction: vi.fn(async (): Promise<ActionResult> => ({ commandId: "m1", durationMs: 1, ok: true })),
    };
  }

  /**
   * Дождаться промиса под фейковыми часами: sendOutbound спит «человеческий конверт», причём таймер
   * сна планируется ПОСЛЕ реального IO (запись консента) — одиночный advance его не догоняет, а
   * advance-цикл без уступки НАСТОЯЩЕМУ event loop'у не даёт fs-коллбэкам отработать. Поэтому каждую
   * итерацию: подвинуть фейковые часы + уступить реальному циклу (setTimeout, захваченный ДО подмены).
   */
  const realSetTimeout = globalThis.setTimeout;
  async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    let out: T | undefined;
    let err: unknown;
    void p.then(
      (v) => { done = true; out = v; },
      (e) => { done = true; err = e; },
    );
    for (let i = 0; i < 200 && !done; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
      await new Promise<void>((r) => realSetTimeout(r, 1));
    }
    if (!done) throw new Error("settle: промис не резолвился под фейковыми часами");
    if (err) throw err;
    return out as T;
  }

  it("идентичный повтор в окне без resend → НЕ уходит, подсказка про resend:true", async () => {
    vi.useFakeTimers();
    try {
      const session = msgSession();
      const ctx = baseCtx({ session });
      // sendOutbound спит «человеческий конверт» (jitter) — под фейковыми часами двигаем время сами.
      const r1 = await settle(messageSend(ctx, { channel: "telegram", to: "Катя", body: "Я люблю тебя" }));
      expect(r1.isError).toBe(false);
      expect(session.sendAction).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_000);

      // Идентичный повтор режется ресенд-гардом ДО sendOutbound (без сна) — await напрямую.
      const r2 = await messageSend(ctx, { channel: "telegram", to: "катя", body: "я люблю тебя!" });
      expect(r2.isError).toBe(false);
      expect(session.sendAction).toHaveBeenCalledTimes(1); // дубль не ушёл
      expect(String(r2.content)).toMatch(/resend:true/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resend:true + confirm → подтверждённый повтор уходит (точный дедуп не блокирует)", async () => {
    vi.useFakeTimers();
    try {
      const session = msgSession();
      const confirm = vi.fn(async () => ({ approved: true }));
      const ctx = baseCtx({ session, confirm });
      await settle(messageSend(ctx, { channel: "telegram", to: "Катя", body: "я люблю тебя" }));
      await vi.advanceTimersByTimeAsync(4_000);

      const r2 = await settle(messageSend(ctx, { channel: "telegram", to: "Катя", body: "я люблю тебя", resend: true }));
      expect(r2.isError).toBe(false);
      expect(session.sendAction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

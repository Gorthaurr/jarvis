/**
 * Ревью 2026-09-24 (T-F6): итог задачи ВЛАДЕЛЬЦА, пришедший, пока он занят (полный экран), не должен молча
 * протухать в очереди. Раньше speakResult ставил его НЕсрочным: busy-гейт §9 держал до освобождения, TTL очереди
 * (2 мин) выбрасывал — владелец спросил из игры, услышал «Берусь, сэр» и ответа не дождался никогда.
 * Проверяем проводку ЦЕЛИКОМ: реальный makeSessionContext → реальный VoicePipeline → синтез (шпион на TTS).
 * Реверт-проверка: верни `voice.speakQueued(reply.voice, false, …)` в router-ws — первый тест упадёт.
 */
import { describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../billing/index.js";
import { TaskManager } from "../brain/tasks/manager.js";
import { MockLlmProvider } from "../integrations/llm.js";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { MockSttProvider, MockTtsProvider } from "../integrations/voice-providers.js";
import { MockWebProvider } from "../integrations/web.js";
import { InMemoryEpisodicMemory } from "../memory/episodic.js";
import { type BrainProviders, makeSessionContext } from "./router-ws.js";
import type { Session } from "./session.js";

function fakeSession(): Session {
  const scopes = new Map<string, unknown>();
  return {
    sessionId: "s1",
    userId: "u1",
    send: vi.fn(),
    sendAction: vi.fn(async () => ({ commandId: "c", ok: true, durationMs: 1 })),
    requestConfirm: vi.fn(),
    onTeardown: vi.fn(),
    channelUp: true,
    scoped: <T>(key: string, init: () => T): T => {
      if (!scopes.has(key)) scopes.set(key, init());
      return scopes.get(key) as T;
    },
  } as unknown as Session;
}

function brainStub(): BrainProviders {
  return {
    llm: new MockLlmProvider([]),
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: { forUser: () => new SpendGuard() },
    tasks: new TaskManager(),
    extBridge: { connected: false, telegramSend: vi.fn(), telegramSendVoice: vi.fn(), openOrFocus: vi.fn() },
  } as unknown as BrainProviders;
}

function setup(busy: boolean) {
  const tts = new MockTtsProvider();
  const synth = vi.spyOn(tts, "synthesize");
  const ctx = makeSessionContext(fakeSession(), { stop: vi.fn() } as never, { stt: new MockSttProvider(), tts } as never, brainStub());
  ctx.lastContext = { fullscreen: busy, locked: false, micBusyByOtherApp: false } as never;
  return { ctx, synth };
}

describe("T-F6: итог задачи владельца доезжает и в полноэкранном режиме", () => {
  it("владелец в полном экране → итог его задачи всё равно звучит (срочный), а не ждёт до протухания", () => {
    const { ctx, synth } = setup(true);
    ctx.agentDeps.speakResult?.({ voice: "Готово, сэр: билд собран." });
    expect(synth).toHaveBeenCalledTimes(1);
    expect(String(synth.mock.calls[0]?.[0])).toContain("билд собран");
  });

  it("проактив (поручение наблюдения) занятость уважает — в полном экране ждёт освобождения", () => {
    const { ctx, synth } = setup(true);
    ctx.agentDeps.speakResult?.({ voice: "Наблюдение сработало, сэр." }, { origin: "proactive" });
    expect(synth).not.toHaveBeenCalled();
  });

  it("свободный владелец — итог звучит как раньше", () => {
    const { ctx, synth } = setup(false);
    ctx.agentDeps.speakResult?.({ voice: "Готово, сэр." });
    expect(synth).toHaveBeenCalledTimes(1);
  });
});

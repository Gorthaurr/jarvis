/**
 * ПРОВОДКА режима выделения: client.selection → session.scoped("selection") → agentDeps.selection (контроль-3).
 *
 * Зачем поведенческий тест: строка `selection: session.scoped("selection", …)` в makeSessionContext —
 * единственное, что связывает сообщение клиента с петлёй. Снять её — client.selection продолжит писать в
 * scoped-слот, петля слота не увидит, строка «владелец ПОКАЗЫВАЕТ на область» никогда не попадёт в промпт, а
 * прогон останется зелёным (loop-тест строит deps руками). Ровно класс «мёртвый gateStoppedRound».
 *
 * Реверт-проверка: удалить `selection:` из agentDeps в router-ws.ts → первый кейс падает.
 */
import { describe, expect, it, vi } from "vitest";
import type { ClientSelection } from "@jarvis/protocol";
import { SpendGuard } from "../billing/index.js";
import { SelectionSlot } from "../brain/agent/selection-context.js";
import { TaskManager } from "../brain/tasks/manager.js";
import { MockLlmProvider } from "../integrations/llm.js";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { MockSttProvider, MockTtsProvider } from "../integrations/voice-providers.js";
import { MockWebProvider } from "../integrations/web.js";
import { InMemoryEpisodicMemory } from "../memory/episodic.js";
import { dispatch, makeSessionContext, type BrainProviders } from "./router-ws.js";
import type { Session } from "./session.js";

const SEL = { x: 1200, y: 400, w: 640, h: 360, monitorIndex: 1, monitor: "Монитор 2 — 2560×1440 (справа)", createdAt: 1 };

/** Session с реальной семантикой scoped(): один экземпляр на ключ — как в бою переживает rebind. */
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
  const tasks = new TaskManager();
  return {
    llm: new MockLlmProvider([]),
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: { forUser: () => new SpendGuard() },
    tasks,
    extBridge: { connected: false, telegramSend: vi.fn(), telegramSendVoice: vi.fn(), openOrFocus: vi.fn() },
  } as unknown as BrainProviders;
}

const envelope = (payload: ClientSelection) => ({ id: "e1", type: "client.selection", payload }) as Parameters<typeof dispatch>[1];

describe("client.selection доезжает до слота, который читает петля", () => {
  it("makeSessionContext сидирует agentDeps.selection ТЕМ ЖЕ экземпляром, в который пишет client.selection", async () => {
    const session = fakeSession();
    const ctx = makeSessionContext(session, { stop: vi.fn() } as never, { stt: new MockSttProvider(), tts: new MockTtsProvider() } as never, brainStub());
    const slot = ctx.agentDeps.selection;
    expect(slot).toBeInstanceOf(SelectionSlot);
    expect(slot?.get()).toBeNull();

    await dispatch(ctx, envelope({ selection: SEL, ageMs: 3_000 }));
    expect(slot?.get()?.selection).toMatchObject({ w: 640, monitorIndex: 1 });
    const key = slot?.key();

    // Повторная присылка ТОЙ ЖЕ рамки (реконнект) не омолаживает указание: ключ идентичности прежний.
    await dispatch(ctx, envelope({ selection: SEL, ageMs: 60_000 }));
    expect(slot?.key()).toBe(key);

    await dispatch(ctx, envelope({ selection: null }));
    expect(slot?.get()).toBeNull();
  });

  it("мусорные поля в client.selection отбрасываются, прежнее состояние слота цело", async () => {
    const session = fakeSession();
    const ctx = makeSessionContext(session, { stop: vi.fn() } as never, { stt: new MockSttProvider(), tts: new MockTtsProvider() } as never, brainStub());
    await dispatch(ctx, envelope({ selection: SEL, ageMs: 0 }));
    await dispatch(ctx, envelope({ selection: { ...SEL, w: Number.NaN }, ageMs: 0 }));
    expect(ctx.agentDeps.selection?.get()?.selection).toMatchObject({ w: 640 });
  });
});

/**
 * H7 — порядок проверки «сокет закрылся, пока handshake ждал БД» (ревью 2026-09-24, B-F5).
 *
 * Живой дефект (лог 24.09 12:18:31): H7 стоял в `.then` вызывающего — ПОСЛЕ doHandshake. А внутри
 * doHandshake уже отработали createOrResume и makeSessionContext, то есть регистрация спикеров
 * напоминаний/наблюдений, а она сразу делает flushPending — отложенное напоминание отдавалось в
 * мёртвый сокет, источник помечал его «доставленным», и владелец его не слышал НИКОГДА.
 *
 * Тест гоняет НАСТОЯЩИЙ doHandshake + настоящий makeSessionContext (брейн-заглушка как в
 * selection-wiring.test.ts): сокет закрывается во время await hydrate → спикеры не регистрируются,
 * сессия не создаётся, handshake отдаёт null. Контроль: при живом сокете тот же стаб доходит до
 * регистрации (иначе тест доказывал бы только «стаб слишком тонкий»).
 * Реверт-проверка: убрать проверку `ws.readyState !== WS_OPEN` перед createOrResume → первый кейс падает
 * на «registerSpeaker был вызван».
 */
import { PROTOCOL_VERSION } from "@jarvis/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@jarvis/shared";
import { SpendGuard } from "../billing/index.js";
import { TaskManager } from "../brain/tasks/manager.js";
import type { ServerConfig } from "../config.js";
import { MockLlmProvider } from "../integrations/llm.js";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { MockSttProvider, MockTtsProvider } from "../integrations/voice-providers.js";
import { MockWebProvider } from "../integrations/web.js";
import { InMemoryEpisodicMemory } from "../memory/episodic.js";
import { SessionRegistry } from "./registry.js";
import type { BrainProviders } from "./router-ws.js";
import { type RawWs, doHandshake } from "./server.js";
import type { SessionSocket } from "./session.js";

const OPEN = 1;
const CLOSED = 3;

function fakeWs(): RawWs & { readyState: number } {
  return { readyState: OPEN, send: vi.fn(), close: vi.fn(), on: vi.fn() } as unknown as RawWs & { readyState: number };
}

function brainStub(onHydrate: () => void) {
  const registerSpeaker = vi.fn();
  const brain = {
    llm: new MockLlmProvider([]),
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: {
      forUser: () => new SpendGuard(),
      hydrate: async () => {
        onHydrate(); // окно await: именно здесь владелец закрыл клиент / оборвалась сеть
      },
    },
    tasks: new TaskManager(),
    reminders: { registerSpeaker, unregisterSpeaker: vi.fn() },
    watch: { registerSpeaker, unregisterSpeaker: vi.fn(), registerActions: vi.fn(), unregisterActions: vi.fn(), registerRunner: vi.fn(), unregisterRunner: vi.fn() },
    extBridge: { connected: false, telegramSend: vi.fn(), telegramSendVoice: vi.fn(), openOrFocus: vi.fn() },
  } as unknown as BrainProviders;
  return { brain, registerSpeaker };
}

const config = { protocolVersion: PROTOCOL_VERSION, product: { enabled: false } } as unknown as ServerConfig;
const hello = {
  id: "h1",
  type: "client.hello",
  ts: 0,
  payload: { protocolVersion: PROTOCOL_VERSION, token: "dev-token", clientVersion: "1.0.0" },
} as unknown as Parameters<typeof doHandshake>[0];
const providers = { stt: new MockSttProvider(), tts: new MockTtsProvider() } as unknown as Parameters<typeof doHandshake>[5];

async function run(closeDuringAwait: boolean) {
  const ws = fakeWs();
  const sock: SessionSocket = {
    send: (d) => ws.send(d),
    close: (c, r) => ws.close(c, r),
    get readyState() {
      return ws.readyState;
    },
  };
  const registry = new SessionRegistry();
  const { brain, registerSpeaker } = brainStub(() => {
    if (closeDuringAwait) ws.readyState = CLOSED;
  });
  const ctx = await doHandshake(hello, sock, ws, config, registry, providers, brain, createLogger("test:h7"));
  return { ctx, registry, registerSpeaker, ws };
}

// Фейковые часы: приветствие стоит на setTimeout(800), heartbeat — на интервале; живые таймеры одного
// кейса иначе стреляли бы посреди следующего (и сожгли бы кулдаун приветствия).
beforeEach(() => {
  vi.useFakeTimers();
  process.env.JARVIS_GREETING_COOLDOWN_MS = "0"; // кулдаун А6 не мешает проверять само приветствие
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  delete process.env.JARVIS_GREETING_COOLDOWN_MS;
});

describe("doHandshake: H7 до регистрации спикеров (B-F5)", () => {
  it("сокет закрылся во время await БД → null, спикеры НЕ зарегистрированы (отложенное не флашится), сессии нет", async () => {
    const { ctx, registry, registerSpeaker } = await run(true);
    expect(registerSpeaker).not.toHaveBeenCalled();
    expect(ctx).toBeNull();
    expect(registry.size).toBe(0);
  });

  it("контроль: живой сокет — тот же стаб доходит до регистрации спикеров и поднимает сессию", async () => {
    const { ctx, registry, registerSpeaker } = await run(false);
    expect(registerSpeaker).toHaveBeenCalled();
    expect(ctx).not.toBeNull();
    expect(registry.size).toBe(1);
    ctx?.voice.dispose();
    ctx?.heartbeat.stop();
  });
});

describe("приветствие не звучит в канал, закрывшийся за задержку онбординга (B-F5)", () => {
  it("сокет закрылся между handshake и таймером приветствия → speak не зовётся (кулдаун А6 не сжигается)", async () => {
    const { ctx, ws } = await run(false);
    const speak = vi.spyOn(ctx!.voice, "speak");
    ws.readyState = CLOSED; // владелец закрыл клиент сразу после подключения
    await vi.advanceTimersByTimeAsync(1_000);
    expect(speak).not.toHaveBeenCalled();
    ctx?.voice.dispose();
  });

  it("контроль: канал жив → приветствие звучит", async () => {
    const { ctx } = await run(false);
    const speak = vi.spyOn(ctx!.voice, "speak");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(speak).toHaveBeenCalledTimes(1);
    ctx?.voice.dispose();
  });
});

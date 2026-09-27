/**
 * Стенд ГОЛОСОВОГО хода на настоящих компонентах (W3 пакет C): настоящий makeSessionContext → настоящий VoicePipeline
 * → настоящий handleUserText; снаружи — только управляемый STT (финал эмитим руками), TTS-провайдер теста, модель-скрипт
 * и сессия-заглушка, которая копит отправленное клиенту (speak.chunk с тегом хода gen — как в проде).
 * dev-сессия (clientVersion «test-…»): своя память, без утренних докладов — чистые первые звуки хода.
 */
import { vi } from "vitest";
import { sleep } from "@jarvis/shared";
import { SpendGuard } from "../../billing/index.js";
import { TaskManager } from "../../brain/tasks/manager.js";
import { type LlmRequest, type LlmResponse, MockLlmProvider, type MockTurn } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import type { ISttProvider, ITtsProvider, SttPartial, SttStream } from "../../integrations/voice-providers.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { type BrainProviders, type SessionContext, makeSessionContext } from "../router-ws.js";
import type { Session } from "../session.js";

/** Модель «как на подписке»: ответ i приходит через delays[i] мс. */
export class SlowLlm extends MockLlmProvider {
  private n = 0;
  constructor(script: MockTurn[], private readonly delays: number[]) {
    super(script);
  }
  override async complete(req: LlmRequest): Promise<LlmResponse> {
    const d = this.delays[this.n] ?? 0;
    this.n += 1;
    if (d > 0) await sleep(d);
    return super.complete(req);
  }
}

/** Управляемый STT: финал реплики эмитим сами (эндпоинт — вне теста). */
class CtrlSttStream implements SttStream {
  readonly live = false;
  private partial?: (p: SttPartial) => void;
  onPartial(cb: (p: SttPartial) => void): void {
    this.partial = cb;
  }
  onError(): void {}
  onClose(): void {}
  pushAudio(): void {}
  emit(p: SttPartial): void {
    this.partial?.(p);
  }
  async close(): Promise<void> {}
}
export class CtrlStt implements ISttProvider {
  readonly live = false;
  last: CtrlSttStream | null = null;
  open(): SttStream {
    this.last = new CtrlSttStream();
    return this.last;
  }
}

export interface SentChunk {
  gen?: number;
  at: number;
}

export interface VoiceRig {
  ctx: SessionContext;
  stt: CtrlStt;
  session: Session;
  sendAction: ReturnType<typeof vi.fn>;
  /** speak.chunk, ушедшие клиенту, по порядку (gen — тег хода для mouth-to-ear). */
  chunks: SentChunk[];
  /** Сказать реплику голосом: wake → финал STT → пайплайн запускает ход. */
  say(text: string): void;
}

export function voiceRig(opts: { llm: MockLlmProvider; tts: ITtsProvider; actionDelayMs?: number; voiceId?: string }): VoiceRig {
  const chunks: SentChunk[] = [];
  const scopes = new Map<string, unknown>();
  const sendAction = vi.fn(async () => {
    if (opts.actionDelayMs) await sleep(opts.actionDelayMs);
    return { commandId: "c", ok: true, durationMs: 1 };
  });
  const session = {
    sessionId: "s1",
    userId: "u1",
    send: vi.fn((type: string, payload: { gen?: number }) => {
      if (type === "speak.chunk") chunks.push({ gen: payload.gen, at: Date.now() });
    }),
    sendAction,
    requestConfirm: vi.fn(),
    onTeardown: vi.fn(),
    channelUp: true,
    scoped: <T>(key: string, init: () => T): T => {
      if (!scopes.has(key)) scopes.set(key, init());
      return scopes.get(key) as T;
    },
  } as unknown as Session;
  const brain = {
    llm: opts.llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: { forUser: () => new SpendGuard() },
    tasks: new TaskManager(),
    extBridge: { connected: false, telegramSend: vi.fn(), telegramSendVoice: vi.fn(), openOrFocus: vi.fn() },
  } as unknown as BrainProviders;
  const stt = new CtrlStt();
  const ctx = makeSessionContext(session, { stop: vi.fn() } as never, { stt, tts: opts.tts, voiceId: opts.voiceId } as never, brain, "test-driver");
  return {
    ctx,
    stt,
    session,
    sendAction,
    chunks,
    say(text: string) {
      ctx.voice.onWake();
      stt.last!.emit({ text, final: true });
    },
  };
}

/** Временно выставить env на время теста (восстанавливает прежние значения). */
export async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

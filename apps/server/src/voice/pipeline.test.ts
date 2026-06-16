import { describe, expect, it, vi } from "vitest";
import type {
  ISttProvider,
  ITtsProvider,
  SttPartial,
  SttStream,
  TtsChunk,
  TtsStream,
} from "../integrations/voice-providers.js";
import { VoicePipeline } from "./pipeline.js";
import type { VoiceState } from "./state.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Управляемый STT-стрим: финал эмитим вручную. */
class CtrlSttStream implements SttStream {
  readonly live = false;
  private partial?: (p: SttPartial) => void;
  closed = false;
  onPartial(cb: (p: SttPartial) => void) {
    this.partial = cb;
  }
  onError() {}
  onClose() {}
  pushAudio() {}
  emit(p: SttPartial) {
    this.partial?.(p);
  }
  async close() {
    this.closed = true;
  }
}
class CtrlSttProvider implements ISttProvider {
  readonly live = false;
  last: CtrlSttStream | null = null;
  open(): SttStream {
    this.last = new CtrlSttStream();
    return this.last;
  }
}

/** Управляемый TTS-стрим: чанки/done эмитим вручную (для barge-in). */
class CtrlTtsStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private doneCb?: () => void;
  private _cancelled = false;
  onChunk(cb: (c: TtsChunk) => void) {
    this.chunkCb = cb;
  }
  onError() {}
  onDone(cb: () => void) {
    this.doneCb = cb;
  }
  cancel() {
    this._cancelled = true;
  }
  get cancelled() {
    return this._cancelled;
  }
  push(seq: number, last: boolean) {
    this.chunkCb?.({ audio: new ArrayBuffer(1), seq, last });
  }
  finish() {
    this.doneCb?.();
  }
}
class CtrlTtsProvider implements ITtsProvider {
  readonly live = false;
  last: CtrlTtsStream | null = null;
  synthesize(): TtsStream {
    this.last = new CtrlTtsStream();
    return this.last;
  }
}

function makePipeline(onUserTurn = vi.fn(async () => ({ voice: "Сейчас три часа." }))) {
  const stt = new CtrlSttProvider();
  const tts = new CtrlTtsProvider();
  const states: VoiceState[] = [];
  const chunks: TtsChunk[] = [];
  const pipe = new VoicePipeline({
    stt,
    tts,
    onUserTurn,
    sendSpeakChunk: (c) => chunks.push(c),
    sendClientState: (s) => states.push(s),
    followupMs: 50,
  });
  return { pipe, stt, tts, states, chunks, onUserTurn };
}

describe("VoicePipeline (§10)", () => {
  it("полный оборот: wake → STT-final → agent → TTS → speak_done → follow-up", async () => {
    const { pipe, stt, tts, states, chunks, onUserTurn } = makePipeline();

    pipe.onWake();
    expect(pipe.state).toBe("listening");
    expect(stt.last).not.toBeNull();

    // STT финализировал фразу
    stt.last!.emit({ text: "который час", final: true });
    await flush();
    expect(onUserTurn).toHaveBeenCalledWith("который час");
    expect(tts.last).not.toBeNull();

    // первый чанк → speaking
    tts.last!.push(0, false);
    expect(pipe.state).toBe("speaking");
    tts.last!.push(1, true);
    expect(chunks).toHaveLength(2);

    // конец синтеза → follow-up окно
    tts.last!.finish();
    expect(pipe.state).toBe("listening");
    expect(states).toContain("thinking");
    expect(states).toContain("speaking");
  });

  it("barge-in во время speaking рубит TTS и не даёт speak_done сработать", async () => {
    const { pipe, stt, tts } = makePipeline();
    pipe.onWake();
    stt.last!.emit({ text: "расскажи анекдот", final: true });
    await flush();
    tts.last!.push(0, false);
    expect(pipe.state).toBe("speaking");

    // юзер перебил
    pipe.onVadEvent("barge_in");
    expect(tts.last!.cancelled).toBe(true);
    expect(pipe.state).toBe("listening");

    // запоздавший done от отменённого стрима не должен открыть follow-up
    tts.last!.finish();
    expect(pipe.state).toBe("listening");
  });

  it("follow-up окно истекает → idle", async () => {
    vi.useFakeTimers();
    try {
      const { pipe, stt, tts } = makePipeline();
      pipe.onWake();
      stt.last!.emit({ text: "привет", final: true });
      await vi.advanceTimersByTimeAsync(1);
      tts.last!.push(0, true);
      tts.last!.finish();
      expect(pipe.state).toBe("listening");
      await vi.advanceTimersByTimeAsync(60); // followupMs=50
      expect(pipe.state).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("§9/§11: проактивный speak() (онбординг) НЕ трогает машину состояний — слух не глохнет", () => {
    // Регрессия «не слышит»: приветствие не должно уводить цикл в speaking и churn'ить STT.
    const { pipe, tts, states } = makePipeline();
    expect(pipe.state).toBe("idle");
    pipe.speak("Здравствуйте, сэр.");
    expect(tts.last).not.toBeNull();
    tts.last!.push(0, false);
    expect(pipe.state).toBe("idle"); // НЕ speaking — fire-and-forget
    tts.last!.push(1, true);
    tts.last!.finish();
    expect(pipe.state).toBe("idle"); // слух как был (wake-on-frame доступен)
    expect(states).not.toContain("speaking");
  });

  it("§20: озвучка фонового итога из idle переоткрывает слух (speaking → listening), не глохнет", () => {
    // Репро бага «спросил и перестал слушать»: фоновая задача произносит вопрос из покоя.
    const { pipe, tts, states } = makePipeline();
    expect(pipe.state).toBe("idle");
    pipe.speakQueued("Отправить Кате «доброе утро»?");
    expect(tts.last).not.toBeNull();
    tts.last!.push(0, false);
    expect(pipe.state).toBe("speaking"); // ВОШЛИ в speaking (раньше застревали в idle)
    tts.last!.push(1, true);
    tts.last!.finish();
    expect(pipe.state).toBe("listening"); // микрофон снова слушает — есть чем ответить
    expect(states).toContain("speaking");
  });

  it("stop() из speaking → idle", async () => {
    const { pipe, stt, tts } = makePipeline();
    pipe.onWake();
    stt.last!.emit({ text: "что-нибудь", final: true });
    await flush();
    tts.last!.push(0, false);
    expect(pipe.state).toBe("speaking");
    pipe.stop();
    expect(pipe.state).toBe("idle");
    expect(tts.last!.cancelled).toBe(true);
  });
});

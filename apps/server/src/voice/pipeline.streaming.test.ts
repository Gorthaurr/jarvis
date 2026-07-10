/**
 * §10 realtime: пофразный путь пайплайна (onUserTurnStream). Ключевое — ОДНА speaking-
 * сессия на несколько фраз: speak_start один раз, speak_done один раз (после последней),
 * корректный возврат в listening+follow-up, barge-in рубит весь стрим, а одиночная фраза
 * ведёт себя как раньше (0 регрессий на частом кейсе).
 */
import { describe, expect, it, vi } from "vitest";
import type {
  ISttProvider,
  ITtsProvider,
  SttPartial,
  SttStream,
  TtsChunk,
  TtsStream,
} from "../integrations/voice-providers.js";
import { type ReplySink, VoicePipeline } from "./pipeline.js";
import type { VoiceState } from "./state.js";
import type { FillerCache } from "./filler-cache.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Фейковый прекеш-филлер: всегда готов, pick отдаёт 4 байта (для тестов тайминга §10). */
function fakeFiller(): FillerCache {
  return { ready: true, size: 1, pick: () => new ArrayBuffer(4) } as unknown as FillerCache;
}

class CtrlSttStream implements SttStream {
  readonly live = false;
  private partial?: (p: SttPartial) => void;
  onPartial(cb: (p: SttPartial) => void) {
    this.partial = cb;
  }
  onError() {}
  onClose() {}
  pushAudio() {}
  emit(p: SttPartial) {
    this.partial?.(p);
  }
  async close() {}
}
class CtrlSttProvider implements ISttProvider {
  readonly live = false;
  last: CtrlSttStream | null = null;
  open(): SttStream {
    this.last = new CtrlSttStream();
    return this.last;
  }
}
class CtrlTtsStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private doneCb?: () => void;
  private _cancelled = false;
  constructor(readonly text: string) {}
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
  push(seq = 0, last = true) {
    this.chunkCb?.({ audio: new ArrayBuffer(1), seq, last });
  }
  finishStream() {
    this.doneCb?.();
  }
}
class CtrlTtsProvider implements ITtsProvider {
  readonly live = false;
  streams: CtrlTtsStream[] = [];
  synthesize(text: string): TtsStream {
    const s = new CtrlTtsStream(text);
    this.streams.push(s);
    return s;
  }
}

function make(opts: { filler?: FillerCache } = {}) {
  const stt = new CtrlSttProvider();
  const tts = new CtrlTtsProvider();
  const states: VoiceState[] = [];
  const chunks: TtsChunk[] = [];
  let sink: ReplySink | null = null;
  let resolveStream: () => void = () => {};
  const pipe = new VoicePipeline({
    stt,
    tts,
    onUserTurn: async () => ({ voice: "не используется" }),
    onUserTurnStream: (_text: string, s: ReplySink) => {
      sink = s;
      return new Promise<void>((res) => {
        resolveStream = res;
      });
    },
    sendSpeakChunk: (c) => chunks.push(c),
    sendClientState: (s) => states.push(s),
    followupMs: 50,
    ...(opts.filler ? { filler: opts.filler } : {}),
  });
  return { stt, tts, pipe, states, chunks, getSink: () => sink!, endStream: () => resolveStream() };
}

async function startTurn(h: ReturnType<typeof make>, text = "привет") {
  h.pipe.onWake();
  h.stt.last!.emit({ text, final: true });
  await flush();
}

describe("VoicePipeline пофразный стрим (§10)", () => {
  it("две фразы: speak_start один раз, серийный синтез, speak_done → listening+follow-up", async () => {
    const h = make();
    await startTurn(h);
    expect(h.pipe.state).toBe("thinking");
    const sink = h.getSink();

    sink.sentence("Первое предложение.");
    expect(h.tts.streams).toHaveLength(1);
    h.tts.streams[0]!.push();
    expect(h.pipe.state).toBe("speaking"); // вошли в speaking на первом звуке

    sink.sentence("Второе предложение."); // в очередь, пока синтезируется первая
    expect(h.tts.streams).toHaveLength(1);
    h.tts.streams[0]!.finishStream(); // первая готова → синтез второй
    expect(h.tts.streams).toHaveLength(2);
    expect(h.tts.streams[1]!.text).toBe("Второе предложение.");

    sink.done("Первое предложение. Второе предложение.");
    expect(h.pipe.state).toBe("speaking"); // ещё говорим вторую
    h.tts.streams[1]!.push();
    h.tts.streams[1]!.finishStream(); // последняя готова → speak_done

    expect(h.pipe.state).toBe("listening"); // follow-up окно
    expect(h.states.filter((s) => s === "speaking")).toHaveLength(1); // ровно один вход в speaking
    expect(h.chunks).toHaveLength(2);
    h.endStream();
  });

  it("одиночная фраза ведёт себя как раньше (speaking → done → listening)", async () => {
    const h = make();
    await startTurn(h, "который час");
    const sink = h.getSink();
    sink.sentence("Сейчас три часа.");
    h.tts.streams[0]!.push(0, true);
    expect(h.pipe.state).toBe("speaking");
    sink.done("Сейчас три часа.");
    h.tts.streams[0]!.finishStream();
    expect(h.pipe.state).toBe("listening");
    h.endStream();
  });

  it("done без стрима (детерминированный путь) произносит реплику целиком", async () => {
    const h = make();
    await startTurn(h);
    const sink = h.getSink();
    sink.done("Здравствуйте, сэр."); // ничего не стримилось → speaker произносит full
    expect(h.tts.streams).toHaveLength(1);
    expect(h.tts.streams[0]!.text).toBe("Здравствуйте, сэр.");
    h.tts.streams[0]!.push();
    expect(h.pipe.state).toBe("speaking");
    h.tts.streams[0]!.finishStream();
    expect(h.pipe.state).toBe("listening");
    h.endStream();
  });

  it("barge-in посреди стрима рубит синтез и очередь, поздние фразы глохнут", async () => {
    const h = make();
    await startTurn(h, "расскажи анекдот");
    const sink = h.getSink();
    sink.sentence("Раз.");
    h.tts.streams[0]!.push();
    expect(h.pipe.state).toBe("speaking");

    h.pipe.onVadEvent("barge_in");
    expect(h.tts.streams[0]!.cancelled).toBe(true);
    expect(h.pipe.state).toBe("listening");

    // brain ещё генерирует и шлёт фразы/финал — всё устарело (gen), глохнет.
    sink.sentence("Два.");
    sink.done("Раз. Два.");
    expect(h.tts.streams).toHaveLength(1); // вторую не синтезировали
    expect(h.pipe.state).toBe("listening");
    h.endStream();
  });

  it("синтез фразы без единого чанка (ошибка TTS) НЕ вешает цикл в thinking (§10)", async () => {
    // Регресс: ElevenLabs при HTTP-ошибке/таймауте зовёт done БЕЗ chunk → speak_start не было.
    // Раньше speak_done из thinking = noop → вечное зависание. Теперь — возврат к слуху.
    const h = make();
    await startTurn(h);
    expect(h.pipe.state).toBe("thinking");
    const sink = h.getSink();
    sink.sentence("Ответ.");
    expect(h.tts.streams).toHaveLength(1);
    h.tts.streams[0]!.finishStream(); // done БЕЗ push() — ноль аудио-чанков
    sink.done("Ответ.");
    expect(h.pipe.state).toBe("listening"); // не застряли в thinking
    h.endStream();
  });

  it("stop() во время стрима → idle, синтез отменён", async () => {
    const h = make();
    await startTurn(h);
    const sink = h.getSink();
    sink.sentence("Первое.");
    h.tts.streams[0]!.push();
    expect(h.pipe.state).toBe("speaking");
    h.pipe.stop();
    expect(h.pipe.state).toBe("idle");
    expect(h.tts.streams[0]!.cancelled).toBe(true);
    h.endStream();
  });
});

describe("VoicePipeline прекеш-филлер (§10 realtime)", () => {
  it("thinking(): через ~250мс играет филлер первым звуком → speaking", async () => {
    vi.useFakeTimers();
    try {
      const h = make({ filler: fakeFiller() });
      h.pipe.onWake();
      h.stt.last!.emit({ text: "поболтай", final: true });
      await vi.advanceTimersByTimeAsync(0); // дотягиваем до await onUserTurnStream (sink захвачен)
      const sink = h.getSink();
      expect(h.pipe.state).toBe("thinking");

      sink.thinking?.(); // brain пошёл к LLM
      expect(h.chunks).toHaveLength(0); // ещё тишина (Opus думает)
      await vi.advanceTimersByTimeAsync(260); // > FILLER_DELAY_MS
      expect(h.chunks).toHaveLength(1); // филлер отправлен ПЕРВЫМ звуком
      expect(h.pipe.state).toBe("speaking"); // вошли в speaking на филлере

      // Реальная реплика подъезжает следом и встаёт за филлером.
      sink.sentence("Привет, сэр.");
      h.tts.streams[0]!.push();
      sink.done("Привет, сэр.");
      h.tts.streams[0]!.finishStream();
      expect(h.pipe.state).toBe("listening");
      h.endStream();
    } finally {
      vi.useRealTimers();
    }
  });

  it("реплика РАНЬШЕ 250мс отменяет филлер (Opus успел) — лишнего звука нет", async () => {
    vi.useFakeTimers();
    try {
      const h = make({ filler: fakeFiller() });
      h.pipe.onWake();
      h.stt.last!.emit({ text: "привет", final: true });
      await vi.advanceTimersByTimeAsync(0);
      const sink = h.getSink();
      sink.thinking?.();
      sink.sentence("Здравствуйте."); // подоспела до таймера → отменяет филлер
      h.tts.streams[0]!.push();
      await vi.advanceTimersByTimeAsync(300);
      expect(h.chunks).toHaveLength(1); // только реплика, филлера НЕТ
      h.endStream();
    } finally {
      vi.useRealTimers();
    }
  });

  it("barge-in во время раздумья отменяет отложенный филлер", async () => {
    vi.useFakeTimers();
    try {
      const h = make({ filler: fakeFiller() });
      h.pipe.onWake();
      h.stt.last!.emit({ text: "расскажи", final: true });
      await vi.advanceTimersByTimeAsync(0);
      const sink = h.getSink();
      sink.thinking?.();
      h.pipe.onVadEvent("barge_in"); // перебил, пока Opus думал
      await vi.advanceTimersByTimeAsync(300);
      expect(h.chunks).toHaveLength(0); // филлер НЕ проигран
      expect(h.pipe.state).toBe("listening");
      h.endStream();
    } finally {
      vi.useRealTimers();
    }
  });

  it("без филлера (нет FillerCache) thinking() — no-op, тишина до реплики", async () => {
    vi.useFakeTimers();
    try {
      const h = make(); // без филлера
      h.pipe.onWake();
      h.stt.last!.emit({ text: "поболтай", final: true });
      await vi.advanceTimersByTimeAsync(0);
      const sink = h.getSink();
      sink.thinking?.();
      await vi.advanceTimersByTimeAsync(300);
      expect(h.chunks).toHaveLength(0); // нет филлера → тишина
      expect(h.pipe.state).toBe("thinking");
      h.endStream();
    } finally {
      vi.useRealTimers();
    }
  });
});

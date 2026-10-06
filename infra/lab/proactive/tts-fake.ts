/**
 * Управляемые TTS/STT для НАСТОЯЩЕГО VoicePipeline. Синтез ведётся на виртуальных таймерах: первый звук через
 * `firstSoundMs`, конец через `speechMs` - очередь озвучки (TTL, дренаж после конца реплики) живёт по виртуальному времени.
 * Режимы: speak (норма), hold (ни звука, ни конца - тест рулит сам), fail (ошибка синтеза), mute-end (конец БЕЗ единого чанка).
 */
import type { ISttProvider, ITtsProvider, SttStream, TtsChunk, TtsStream } from "../../../apps/server/src/integrations/voice-providers.js";
import { FAULT } from "./kit.js";

export type TtsMode = "speak" | "hold" | "fail" | "mute-end";

export class FakeStream implements TtsStream {
  cancelled = false;
  private chunk?: (c: TtsChunk) => void;
  private err?: (e: Error) => void;
  private done?: () => void;
  onChunk(cb: (c: TtsChunk) => void): void {
    this.chunk = cb;
  }
  onError(cb: (e: Error) => void): void {
    this.err = cb;
  }
  onDone(cb: () => void): void {
    this.done = cb;
  }
  cancel(): void {
    this.cancelled = true;
  }
  /** Ручное управление (режим hold). */
  emitChunk(): void {
    if (!this.cancelled) this.chunk?.({ audio: new ArrayBuffer(1), seq: 0, last: true });
  }
  finish(): void {
    if (!this.cancelled) this.done?.();
  }
  /** Как реальный провайдер (yandex-tts.ts:151-155): ошибка, затем ВСЕГДА конец - иначе стрим остался бы «живым». */
  fail(message = "lab: синтез недоступен"): void {
    if (this.cancelled) return;
    this.err?.(new Error(message));
    this.finish();
  }
}

export class FakeTts implements ITtsProvider {
  readonly live = false;
  mode: TtsMode = FAULT === "deaf" ? "hold" : "speak";
  firstSoundMs = 0;
  speechMs = 2_000;
  /** Текст последнего синтеза = того, что сейчас звучит (пайплайн держит один стрим). */
  lastText = "";
  last?: FakeStream;
  readonly texts: string[] = [];

  synthesize(text: string): TtsStream {
    const s = new FakeStream();
    this.lastText = text;
    this.last = s;
    this.texts.push(text);
    if (this.mode === "speak") {
      this.later(() => s.emitChunk(), this.firstSoundMs);
      this.later(() => s.finish(), Math.max(this.speechMs, this.firstSoundMs + 1));
    } else if (this.mode === "fail") this.later(() => s.fail(), 0);
    else if (this.mode === "mute-end") this.later(() => s.finish(), 0);
    return s;
  }

  /** Нулевая задержка = микрозадача (звук в ту же миллисекунду, а fake setTimeout(0) сдвинул бы на 1 мс). */
  private later(fn: () => void, ms: number): void {
    if (ms <= 0) queueMicrotask(fn);
    else setTimeout(fn, ms);
  }
}

class NullStream implements SttStream {
  readonly live = false;
  pushAudio(): void {}
  onPartial(): void {}
  onError(): void {}
  onClose(): void {}
  async close(): Promise<void> {}
}

/** STT в этом стенде не участвует (речь владельца не подаётся), но пайплайн может открыть стрим после реплики. */
export class NullStt implements ISttProvider {
  readonly live = false;
  open(): SttStream {
    return new NullStream();
  }
}

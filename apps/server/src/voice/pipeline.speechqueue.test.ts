/**
 * Регресс §20: очередь озвучки фоновых итогов не должна ЗАСТРЕВАТЬ после barge-in/возврата
 * в idle (баг ревью), а явный «стоп»/«отмени» должен её ОЧИЩАТЬ (не озвучивать стейл).
 */
import { describe, expect, it } from "vitest";
import type {
  ISttProvider,
  ITtsProvider,
  SttPartial,
  SttStream,
  TtsChunk,
  TtsStream,
} from "../integrations/voice-providers.js";
import { VoicePipeline } from "./pipeline.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

class CtrlSttStream implements SttStream {
  readonly live = false;
  private partial?: (p: SttPartial) => void;
  onPartial(cb: (p: SttPartial) => void) { this.partial = cb; }
  onError() {}
  onClose() {}
  pushAudio() {}
  emit(p: SttPartial) { this.partial?.(p); }
  async close() {}
}
class CtrlSttProvider implements ISttProvider {
  readonly live = false;
  last: CtrlSttStream | null = null;
  open(): SttStream { this.last = new CtrlSttStream(); return this.last; }
}
class CtrlTtsStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private doneCb?: () => void;
  private _cancelled = false;
  onChunk(cb: (c: TtsChunk) => void) { this.chunkCb = cb; }
  onError() {}
  onDone(cb: () => void) { this.doneCb = cb; }
  cancel() { this._cancelled = true; }
  get cancelled() { return this._cancelled; }
}
class CtrlTtsProvider implements ITtsProvider {
  readonly live = false;
  texts: string[] = [];
  synthesize(text: string): TtsStream { this.texts.push(text); return new CtrlTtsStream(); }
}

function make(onUserTurn: () => Promise<{ voice: string }>) {
  const stt = new CtrlSttProvider();
  const tts = new CtrlTtsProvider();
  const pipe = new VoicePipeline({ stt, tts, onUserTurn, sendSpeakChunk: () => {}, sendClientState: () => {}, followupMs: 50 });
  return { stt, tts, pipe };
}

/** Пайплайн с управляемым флагом «пользователь занят» (§9). Свежий = idle → дренаж сразу. */
function makeBusy(busy: { value: boolean }) {
  const tts = new CtrlTtsProvider();
  const pipe = new VoicePipeline({
    stt: new CtrlSttProvider(), tts,
    onUserTurn: async () => ({ voice: "" }),
    sendSpeakChunk: () => {}, sendClientState: () => {}, followupMs: 50,
    isUserBusy: () => busy.value,
  });
  return { tts, pipe };
}

describe("очередь озвучки фоновых итогов (§20)", () => {
  it("НЕ застревает: проливается при возврате в idle после barge-in на thinking", async () => {
    const turn: { resolve?: (r: { voice: string }) => void } = {};
    const { stt, tts, pipe } = make(() => new Promise((res) => { turn.resolve = res; }));

    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();
    expect(pipe.state).toBe("thinking");

    pipe.speakQueued("Готово, нашёл 5 машин."); // в thinking — в очередь, не озвучивается
    expect(tts.texts).not.toContain("Готово, нашёл 5 машин.");

    pipe.onVadEvent("barge_in"); // перебил на thinking
    turn.resolve?.({ voice: "Поздний ответ." }); // отброшен (gen mismatch)
    await flush();

    pipe.mute(); // канал освободился → idle
    await flush();

    expect(tts.texts).toContain("Готово, нашёл 5 машин."); // пролился, не застрял
  });

  it("явный «стоп»/«отмени» (clearPendingSpeech) очищает очередь — стейл НЕ озвучивается", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();
    pipe.speakQueued("Стейл-итог.");
    pipe.clearPendingSpeech(); // роутер зовёт это на «стоп»/«отмени»
    pipe.mute();
    await flush();
    expect(tts.texts).not.toContain("Стейл-итог.");
  });
});

describe("§9 уважительная проактивность — не мешать занятому пользователю", () => {
  it("занят (звонок/полный экран) → НЕсрочный фоновый итог ДЕРЖИТСЯ, не озвучивается", () => {
    const { tts, pipe } = makeBusy({ value: true });
    pipe.speakQueued("Готово, нашёл пять машин."); // несрочное
    expect(tts.texts).not.toContain("Готово, нашёл пять машин.");
  });

  it("занят → СРОЧНОЕ напоминание (будильник) озвучивается ВСЁ РАВНО", () => {
    const { tts, pipe } = makeBusy({ value: true });
    pipe.speakQueued("Пора в зал, сэр.", true); // urgent
    expect(tts.texts).toContain("Пора в зал, сэр.");
  });

  it("освободился (drainPending) → отложенный несрочный итог отдаётся", () => {
    const busy = { value: true };
    const { tts, pipe } = makeBusy(busy);
    pipe.speakQueued("Готово, нашёл пять машин.");
    expect(tts.texts).not.toContain("Готово, нашёл пять машин."); // держится, пока занят
    busy.value = false; // вышел из звонка/полноэкранки
    pipe.drainPending();
    expect(tts.texts).toContain("Готово, нашёл пять машин."); // отдан по освобождении
  });
});

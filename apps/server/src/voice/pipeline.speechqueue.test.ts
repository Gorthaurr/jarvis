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

// 🔴 Живая жалоба 2026-07-24: «договаривает уже спустя минуты 2 сразу всё скопом». Очередь фоновых
// итогов не имела ни срока годности, ни капа — накопленное вываливалось пачкой, причём протухшие
// реплики звучали как свежие (владелец слышит ответ на вопрос, о котором давно забыл).
describe("очередь озвучки: срок годности и кап (анти-«скопом через минуты»)", () => {
  it("протухший НЕсрочный итог не произносится (текст ход уже отдал в чат)", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();
    expect(pipe.state).toBe("thinking"); // канал занят → итог ляжет в очередь

    pipe.speakQueued("Итог, который протух.");
    // Пролежал дольше JARVIS_SPEECH_QUEUE_TTL_MS (деф 120с) — двигаем часы вперёд.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 3 * 60_000;
      pipe.mute(); // канал освободился → дренаж
      await flush();
      expect(tts.texts).not.toContain("Итог, который протух.");
    } finally {
      Date.now = realNow;
    }
  });

  it("СРОЧНОЕ (напоминание) не протухает никогда — прозвучит и через час", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();

    pipe.speakQueued("Напоминание: выпить таблетки.", true); // urgent
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 60 * 60_000;
      pipe.mute();
      await flush();
      expect(tts.texts).toContain("Напоминание: выпить таблетки.");
    } finally {
      Date.now = realNow;
    }
  });

  it("кап очереди: десяток накопленных итогов не превращается в пачку — старые вытесняются", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();

    for (let i = 1; i <= 8; i += 1) pipe.speakQueued(`Итог номер ${i}.`);
    pipe.mute();
    await flush();
    // Самые старые вытеснены капом (деф 4); свежий — на месте.
    expect(tts.texts).not.toContain("Итог номер 1.");
    expect(tts.texts.length).toBeLessThanOrEqual(4);
  });
});

// Ревью фиксов речи 2026-07-24: fail-safe (сохранение отменённой реплики) не должен воскрешать то,
// что владелец ЗАПРЕТИЛ, и не должен переозвучивать уже услышанное.
describe("fail-safe отменённой реплики — границы (ревью)", () => {
  it("CRITICAL: после «заткнись» отменённая реплика НЕ всплывает из очереди", async () => {
    const turn: { resolve?: (r: { voice: string }) => void } = {};
    const { stt, tts, pipe } = make(() => new Promise((res) => { turn.resolve = res; }));
    pipe.onWake();
    stt.last!.emit({ text: "какая погода", final: true });
    await flush();
    expect(pipe.state).toBe("thinking");

    // Владелец: «заткнись» → роутер зовёт stop-путь + чистку очереди.
    pipe.onVadEvent("barge_in");
    pipe.clearPendingSpeech();
    turn.resolve?.({ voice: "Сегодня пасмурно, плюс восемь." }); // ход договорил ПОСЛЕ запрета
    await flush();
    pipe.mute(); // канал свободен — если бы реплика попала в очередь, она бы прозвучала
    await flush();

    expect(tts.texts).not.toContain("Сегодня пасмурно, плюс восемь.");
  });

  it("перебивание в РАЗДУМЬЕ (речь ещё не пошла) → реплика сохраняется и звучит позже", async () => {
    const turn: { resolve?: (r: { voice: string }) => void } = {};
    const { stt, tts, pipe } = make(() => new Promise((res) => { turn.resolve = res; }));
    pipe.onWake();
    stt.last!.emit({ text: "какая погода", final: true });
    await flush();

    pipe.onVadEvent("barge_in"); // перебил, но НЕ просил молчать
    turn.resolve?.({ voice: "Сегодня пасмурно, плюс восемь." });
    await flush();
    pipe.mute();
    await flush();

    expect(tts.texts).toContain("Сегодня пасмурно, плюс восемь."); // работа не пропала
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

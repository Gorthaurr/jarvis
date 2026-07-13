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
import { MockSpeakerVerifier, type VoiceProfile } from "./speaker/verifier.js";
import type { TurnDetector } from "./turn.js";

/** Турн-детектор-заглушка: всегда «endpoint» на speech_end (для теста гейта диктора). */
function alwaysEndpointTurn(): TurnDetector {
  return {
    onSpeechStart() {},
    onInterim() {},
    onSpeechEnd: () => "endpoint",
    tick: () => "wait",
    reset() {},
    minSilenceMs: 200,
    maxSilenceMs: 800,
  } as unknown as TurnDetector;
}

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

function makePipeline(
  onUserTurn = vi.fn(async () => ({ voice: "Сейчас три часа." })),
  onMouthToEar?: (ms: number, turnSeq: number) => void,
) {
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
    onMouthToEar,
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

  it("инкремент 0 (ревью #1): чанки РАЗНЫХ ходов несут РАЗНЫЕ turn-теги (gen) — mouth-to-ear не молчит со 2-го хода", async () => {
    const { pipe, stt, tts, chunks } = makePipeline();
    // ход 1
    pipe.onWake();
    stt.last!.emit({ text: "который час", final: true });
    await flush();
    tts.last!.push(0, false);
    tts.last!.push(1, true);
    const gen1 = chunks[0]!.gen;
    expect(typeof gen1).toBe("number");
    tts.last!.finish(); // конец синтеза → listening → ensureStt следующего хода (turnSeq++)

    // ход 2 (БЕЗ barge-in между ходами)
    stt.last!.emit({ text: "а какое число", final: true });
    await flush();
    tts.last!.push(0, false);
    const gen2 = chunks[chunks.length - 1]!.gen;
    expect(typeof gen2).toBe("number");
    // РАЗНЫЙ ход → РАЗНЫЙ тег. На старом gen (bump только в cancelTts) оба были бы равны → клиент
    // дедупил бы 2-й ход и mouth-to-ear молчал бы со второго хода (ровно баг ревью #1).
    expect(gen2).not.toBe(gen1);
  });

  it("инкремент 0 (ревью раунд3 #1): mouth-to-ear ПИШЕТСЯ для короткой mp3-реплики (ack ПОСЛЕ follow-up сброса)", async () => {
    const m2e = vi.fn();
    const { pipe, stt, tts, chunks } = makePipeline(undefined, m2e);
    pipe.onWake();
    stt.last!.emit({ text: "который час", final: true });
    await flush();
    // ОДНА фраза, сразу last:true → speak_done продвинет turnSeq и сбросит latency-трекер СИНХРОННО
    tts.last!.push(0, true);
    const replyTag = chunks[0]!.gen!;
    tts.last!.finish(); // speak_done → follow-up ensureStt (turnSeq++, latency.reset())
    // ack клиента приходит ПОЗЖЕ с тегом СТАРОГО хода — снапшот всё равно считает mouth-to-ear
    pipe.onAudioPlayed(replyTag, Date.now() + 1_000);
    expect(m2e).toHaveBeenCalledTimes(1); // на turnSeq-гейте (без снапшота) метрика была бы потеряна
    expect(m2e.mock.calls[0]![0]).toBeGreaterThanOrEqual(0); // положительный mouth-to-ear
  });

  it("инкремент 0: чужой/опоздавший ack (несуществующий ход) — mouth-to-ear НЕ пишем", async () => {
    const m2e = vi.fn();
    const { pipe, stt, tts } = makePipeline(undefined, m2e);
    pipe.onWake();
    stt.last!.emit({ text: "который час", final: true });
    await flush();
    tts.last!.push(0, true);
    tts.last!.finish();
    pipe.onAudioPlayed(999, Date.now() + 1_000); // тег, которого не было
    expect(m2e).not.toHaveBeenCalled();
  });

  it("инкремент 0 (fix мис-атрибуции): проактив speak()/фоновый speakQueued НЕ тегают чанки turn-seq", async () => {
    // Ответ ХОДА тегируется turnSeq (клиент вернёт его в audio.played → mouth-to-ear ЭТОГО хода). Но
    // проактив/онбординг/фоновый итог задачи НЕ должны нести тег: их ack замкнулся бы на висящий снапшот
    // хода (тихий-финал/непотреблённый снапшот) → ложные «минуты» →ухо (мис-атрибуция, находка ревью).
    const { pipe, stt, tts, chunks } = makePipeline();
    pipe.onWake();
    stt.last!.emit({ text: "который час", final: true });
    await flush();
    tts.last!.push(0, true);
    expect(typeof chunks[chunks.length - 1]!.gen).toBe("number"); // собственный ответ хода — тегирован
    tts.last!.finish();
    // фоновый итог из покоя (turnSeq тот же, снапшот хода мог висеть) — БЕЗ тега
    pipe.speakQueued("Кате отправил, сэр.");
    tts.last!.push(0, true);
    expect(chunks[chunks.length - 1]!.gen).toBeUndefined();
    tts.last!.finish();
    // проактивный speak() (напоминание/приветствие) — тоже БЕЗ тега
    pipe.speak("Не забудьте про встречу.");
    tts.last!.push(0, true);
    expect(chunks[chunks.length - 1]!.gen).toBeUndefined();
  });

  it("инкремент 0 (sanity-потолок): АБСУРДНЫЙ ack (>10 мин) отброшен, но МЕДЛЕННЫЙ легитимный ход (десятки секунд) ПИШЕТСЯ", async () => {
    // Ревью инкремента 0: прежние 30с молча резали легитимный P95-хвост (многораундовый разговорный ход:
    // filler off → первая фраза после tool-петли, до ~loopMaxMs). Теперь потолок ловит ЛИШЬ абсурд (>10 мин
    // = clock-skew/грубая мис-корреляция), а реальный медленный ход записывается.
    const m2e = vi.fn();
    const { pipe, stt, tts, chunks } = makePipeline(undefined, m2e);
    pipe.onWake();
    stt.last!.emit({ text: "почему падает биткоин", final: true });
    await flush();
    tts.last!.push(0, true);
    const tag = chunks[chunks.length - 1]!.gen!; // == turnSeq == snap.seq (совпадёт со снапшотом)
    tts.last!.finish();
    pipe.onAudioPlayed(tag, Date.now() + 11 * 60_000); // ack через 11 минут — абсурд, отброшен
    expect(m2e).not.toHaveBeenCalled();

    // МЕДЛЕННЫЙ, но легитимный ход (60с до первого звука через несколько tool-раундов) ПИШЕТСЯ.
    const m2e2 = vi.fn();
    const p2 = makePipeline(undefined, m2e2);
    p2.pipe.onWake();
    p2.stt.last!.emit({ text: "сравни доллар и евро", final: true });
    await flush();
    p2.tts.last!.push(0, true);
    const tag2 = p2.chunks[p2.chunks.length - 1]!.gen!;
    p2.tts.last!.finish();
    p2.pipe.onAudioPlayed(tag2, Date.now() + 60_000); // 60с — медленный, но легитимный (раньше резалось 30с-потолком)
    expect(m2e2).toHaveBeenCalledTimes(1);
    expect(m2e2.mock.calls[0]![0]).toBeGreaterThanOrEqual(59_000);
  });

  it("инкремент 0: пофразный стрим-путь (runAgentStreaming) тоже тегает ответ хода turn-seq", async () => {
    // Прод по умолчанию идёт через onUserTurnStream (PhraseSpeaker, ИНОЙ сайт тегирования, чем runAgent).
    // Проверяем, что собственный ответ стрим-хода несёт turn-seq (клиент вернёт его → mouth-to-ear ЭТОГО хода).
    const stt = new CtrlSttProvider();
    const tts = new CtrlTtsProvider();
    const chunks: TtsChunk[] = [];
    const pipe = new VoicePipeline({
      stt,
      tts,
      onUserTurn: vi.fn(async () => ({ voice: "фолбэк" })),
      onUserTurnStream: async (_t, sink) => {
        sink.sentence("Готово, сэр.");
        sink.done("Готово, сэр.");
      },
      sendSpeakChunk: (c) => chunks.push(c),
      sendClientState: () => {},
      followupMs: 50,
    });
    pipe.onWake();
    stt.last!.emit({ text: "сделай отчёт", final: true });
    await flush();
    expect(tts.last).not.toBeNull(); // PhraseSpeaker синтезировал фразу
    tts.last!.push(0, true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(typeof chunks[chunks.length - 1]!.gen).toBe("number"); // ответ хода тегирован и на стрим-пути
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

describe("VoicePipeline — окно разговора (wake word, §3)", () => {
  /**
   * Сетап с requireWakeWord + управляемыми часами. say() прогоняет полный ход: эмитит финал
   * на текущем STT-стриме и, если агента позвали, докручивает TTS до speak_done (→ снова
   * listening). followupMs огромный — таймер follow-up не вмешивается в проверку окна.
   */
  function setup(conversationWindowMs: number) {
    let clock = 0;
    const stt = new CtrlSttProvider();
    const tts = new CtrlTtsProvider();
    const onUserTurn = vi.fn(async () => ({ voice: "Готово." }));
    const pipe = new VoicePipeline({
      stt,
      tts,
      onUserTurn,
      sendSpeakChunk: () => {},
      sendClientState: () => {},
      requireWakeWord: true,
      conversationWindowMs,
      followupMs: 1_000_000,
      now: () => clock,
    });
    const advance = (ms: number) => {
      clock += ms;
    };
    const say = async (text: string) => {
      pipe.onWake(); // гарантируем listening + открытый STT (идемпотентно в активном окне)
      const callsBefore = onUserTurn.mock.calls.length;
      stt.last!.emit({ text, final: true });
      await flush();
      // Агента позвали (реплика принята) → докрутим свежий TTS до speak_done (→ снова listening).
      if (onUserTurn.mock.calls.length > callsBefore && tts.last) {
        tts.last.push(0, true);
        tts.last.finish();
        await flush();
      }
    };
    return { pipe, onUserTurn, advance, say };
  }

  it("без обращения «Джарвис» до пробуждения — игнор (агент не зовётся)", async () => {
    const { onUserTurn, say } = setup(1_000);
    await say("открой блокнот");
    expect(onUserTurn).not.toHaveBeenCalled();
  });

  it("«Джарвис» будит; дальше в окне можно без обращения", async () => {
    const { onUserTurn, say } = setup(1_000);
    await say("Джарвис, который час");
    expect(onUserTurn).toHaveBeenLastCalledWith("который час");
    await say("а какое число"); // без «Джарвис», окно ещё открыто
    expect(onUserTurn).toHaveBeenLastCalledWith("а какое число");
    expect(onUserTurn).toHaveBeenCalledTimes(2);
  });

  it("окно КАТИТСЯ от каждой принятой реплики (корень фикса «глохнет посреди разговора»)", async () => {
    const { onUserTurn, advance, say } = setup(1_000);
    await say("Джарвис, привет"); // t=0
    advance(800); // < окна
    await say("как дела"); // принято → окно сдвинулось на t=800
    advance(800); // t=1600: >1000 от ПЕРВОЙ реплики, но <1000 от второй
    await say("спасибо"); // принимается благодаря качению окна
    expect(onUserTurn).toHaveBeenNthCalledWith(3, "спасибо");
    expect(onUserTurn).toHaveBeenCalledTimes(3);
  });

  it("после паузы дольше окна реплика без обращения — игнор", async () => {
    const { onUserTurn, advance, say } = setup(1_000);
    await say("Джарвис, привет");
    const calls = onUserTurn.mock.calls.length;
    advance(2_000); // > окна, активности не было
    await say("ещё раз"); // без «Джарвис» → игнор
    expect(onUserTurn).toHaveBeenCalledTimes(calls);
  });
});

describe("VoicePipeline — верификация диктора (§3 kill-фича)", () => {
  const PROFILE: VoiceProfile = { name: "Антон", data: new Uint8Array([1]), createdAt: 0 };

  function setup(score: number) {
    const stt = new CtrlSttProvider();
    const tts = new CtrlTtsProvider();
    const onUserTurn = vi.fn(async () => ({ voice: "Готово." }));
    const verifier = new MockSpeakerVerifier({ ready: true, threshold: 0.5, match: () => ({ name: "Антон", score }) });
    const pipe = new VoicePipeline({
      stt,
      tts,
      onUserTurn,
      sendSpeakChunk: () => {},
      sendClientState: () => {},
      turnDetector: alwaysEndpointTurn(),
      speaker: { verifier, profiles: () => [PROFILE] },
    });
    // Прогон хода через VAD-эндпоинт (где работает гейт): wake → речь (interim+аудио) → speech_end.
    const turn = async (text: string) => {
      pipe.onWake();
      stt.last!.emit({ text, final: false }); // interim — для спекулятивного финала
      pipe.onAudioFrame(new Int16Array([10, 20, 30, 40]).buffer); // накопить аудио хода (>0)
      pipe.onVadEvent("speech_end"); // endpoint → checkSpeaker (async) → gateWake
      await flush();
      await flush();
    };
    return { onUserTurn, turn, stt, pipe };
  }

  it("СВОЙ голос (score ≥ порога) → реплика обрабатывается", async () => {
    const { onUserTurn, turn } = setup(0.82);
    await turn("какая погода");
    expect(onUserTurn).toHaveBeenCalledWith("какая погода");
  });

  it("ЧУЖОЙ голос/музыка (score < порога) → ход молча отброшен (агент не зван)", async () => {
    const { onUserTurn, turn } = setup(0.2);
    await turn("какая погода");
    expect(onUserTurn).not.toHaveBeenCalled();
  });

  it("ПОЗДНИЙ реальный финал отклонённого хода НЕ протекает после переоткрытия STT (фикс протечки гейта)", async () => {
    const { onUserTurn, stt, pipe } = setup(0.2); // чужой
    // 1. Отклонённый ход: interim + аудио + эндпоинт. Спекулятивный путь блокируется.
    pipe.onWake();
    const rejectedStream = stt.last!; // запоминаем стрим отклонённого хода
    rejectedStream.emit({ text: "какая погода", final: false });
    pipe.onAudioFrame(new Int16Array([10, 20, 30, 40]).buffer);
    pipe.onVadEvent("speech_end"); // endpoint → checkSpeaker → speakerRejected + пометка стрима
    await flush();
    await flush();
    expect(onUserTurn).not.toHaveBeenCalled();
    // 2. Новый цикл слушания (idle→wake→open_stt) СБРАСЫВАЕТ глобальный speakerRejected и открывает
    //    НОВЫЙ стрим — именно здесь раньше терялся вердикт для позднего финала старого стрима.
    pipe.onWake();
    await flush();
    expect(stt.last).not.toBe(rejectedStream); // действительно открылся новый стрим
    // 3. Поздний реальный финал приходит на СТАРОМ стриме (как делает Deepgram на close).
    rejectedStream.emit({ text: "какая погода", final: true });
    await flush();
    await flush();
    expect(onUserTurn).not.toHaveBeenCalled(); // НЕ должен протечь к агенту
  });
});

describe("VoicePipeline — само-восстановление прослушки (§10 «глохнет после пустого хода»)", () => {
  it("STT закрылся в listening (эндпоинт без транскрипта) → следующий кадр ПЕРЕОТКРЫВАЕТ стрим", async () => {
    const stt = new CtrlSttProvider();
    const pipe = new VoicePipeline({
      stt,
      tts: new CtrlTtsProvider(),
      onUserTurn: vi.fn(async () => ({ voice: "ок" })),
      sendSpeakChunk: () => {},
      sendClientState: () => {},
      turnDetector: alwaysEndpointTurn(),
    });
    // 1. Активация: первый кадр из idle → wake → открыт STT (stream1), состояние listening.
    pipe.onAudioFrame(new Int16Array([1, 2, 3, 4]).buffer);
    const stream1 = stt.last!;
    expect(stream1).not.toBeNull();
    // 2. Пустой эндпоинт (тишина/чужой без транскрипта): speech_end → close_stt. Состояние остаётся
    //    listening, но STT закрыт — раньше тут Джарвис «глох» навсегда (кадры в закрытый стрим).
    pipe.onVadEvent("speech_end");
    await flush();
    expect(stream1.closed).toBe(true);
    // 3. Следующий кадр в listening с закрытым STT → САМО-восстановление: открывается новый стрим.
    pipe.onAudioFrame(new Int16Array([5, 6, 7, 8]).buffer);
    expect(stt.last).not.toBe(stream1); // переоткрылся — Джарвис снова слышит
  });
});

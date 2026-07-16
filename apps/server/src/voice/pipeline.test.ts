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
    expect(onUserTurn).toHaveBeenCalledWith("который час", expect.anything());
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
    return { pipe, stt, onUserTurn, advance, say };
  }

  it("без обращения «Джарвис» до пробуждения — игнор (агент не зовётся)", async () => {
    const { onUserTurn, say } = setup(1_000);
    await say("открой блокнот");
    expect(onUserTurn).not.toHaveBeenCalled();
  });

  it("«Джарвис» будит; дальше в окне можно без обращения", async () => {
    const { onUserTurn, say } = setup(1_000);
    await say("Джарвис, который час");
    expect(onUserTurn).toHaveBeenLastCalledWith("который час", expect.anything());
    await say("а какое число"); // без «Джарвис», окно ещё открыто
    expect(onUserTurn).toHaveBeenLastCalledWith("а какое число", expect.anything());
    expect(onUserTurn).toHaveBeenCalledTimes(2);
  });

  it("окно КАТИТСЯ от каждой принятой реплики (корень фикса «глохнет посреди разговора»)", async () => {
    const { onUserTurn, advance, say } = setup(1_000);
    await say("Джарвис, привет"); // t=0
    advance(800); // < окна
    await say("как дела"); // принято → окно сдвинулось на t=800
    advance(800); // t=1600: >1000 от ПЕРВОЙ реплики, но <1000 от второй
    await say("спасибо"); // принимается благодаря качению окна
    expect(onUserTurn).toHaveBeenNthCalledWith(3, "спасибо", expect.anything());
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

  // Акустика «строгий wake в шуме» (#1/#2): фон/видео/второй голос затапливали пайплайн через катящееся
  // окно разговора. Теперь при частоте НЕадресованных реплик обстановка признаётся зашумлённой → окно
  // отключается: команда БЕЗ «Джарвис» игнорируется, пока фон не стихнет.
  it("зашумлённая обстановка (≥3 НЕадресованных) → в окне разговора команда БЕЗ «Джарвис» игнорируется", async () => {
    const { onUserTurn, say } = setup(10_000); // большое окно разговора (не истекает по времени в тесте)
    // фон/видео: 3 НЕадресованные реплики (без «Джарвис») копят сигнал шума
    await say("кто-то говорит по телефону рядом");
    await say("а потом фраза из видео на фоне");
    await say("и третья реплика фоном идёт");
    expect(onUserTurn).not.toHaveBeenCalled(); // все проигнорированы (нет обращения)
    // штатное пробуждение работает всегда
    await say("Джарвис, поставь паузу");
    expect(onUserTurn).toHaveBeenLastCalledWith("поставь паузу", expect.anything());
    // в ШУМЕ фраза в окне БЕЗ «Джарвис» — ИГНОР (строгий wake), хотя окно ещё открыто
    const calls = onUserTurn.mock.calls.length;
    await say("продолжай дальше");
    expect(onUserTurn).toHaveBeenCalledTimes(calls); // НЕ принято
    // а с «Джарвис» — принято даже в шуме
    await say("Джарвис, следующий трек");
    expect(onUserTurn).toHaveBeenLastCalledWith("следующий трек", expect.anything());
  });

  it("тихая обстановка — окно разговора принимает без «Джарвис» (строгий wake НЕ включается)", async () => {
    const { onUserTurn, say } = setup(10_000);
    await say("Джарвис, привет"); // 1 пробуждение, шума нет
    await say("а как дела"); // в окне, обстановка тихая → принято как прежде
    expect(onUserTurn).toHaveBeenLastCalledWith("а как дела", expect.anything());
    expect(onUserTurn).toHaveBeenCalledTimes(2);
  });

  it("акустика: строгий режим НЕ самоподдерживается владельцем; распад при маскированном сигнале закрывает окно (одно «Джарвис» возвращает диалог)", async () => {
    // HIGH-находка «оглох на владельца»: заблокированные строгим режимом реплики в открытом окне НЕ идут
    // в счётчик шума (само-поддержка) — режим спадает по распаду фоновых записей. НО (ревью #2): раз режим
    // БЛОКИРОВАЛ реплики в открытом окне, сигнал был МАСКИРОВАН — «тишина» не доказана (фон мог продолжаться).
    // Выход тогда КОНСЕРВАТИВНЫЙ: окно разговора закрывается (цена владельцу — одно «Джарвис»), иначе первая
    // же фраза фона после выхода принималась бы командой и катила окно бессрочно (флуд возвращался).
    const { onUserTurn, advance, say } = setup(60_000); // окно разговора большое — не истекает по времени
    await say("фон один"); // фон ДО разговора (окно закрыто) — 3 реплики → шумный режим
    await say("фон два");
    await say("фон три");
    await say("Джарвис, поставь паузу"); // проснулись (в шуме wake работает всегда)
    const calls = onUserTurn.mock.calls.length;
    advance(12_000);
    await say("громче"); // владелец БЕЗ «Джарвис» в шуме → блок (строгий); в счётчик шума НЕ идёт (маркер маскировки)
    advance(12_000);
    await say("ещё громче"); // снова блок, снова НЕ в счётчик
    expect(onUserTurn).toHaveBeenCalledTimes(calls); // обе заблокированы (строгий wake)
    advance(10_000); // t≈34с: фоновые таймстампы (t=0) истекли (>30с), команды владельца их НЕ пополняли
    await say("теперь без обращения"); // режим СНЯТ (не самоподдержался), но сигнал был маскирован →
    expect(onUserTurn).toHaveBeenCalledTimes(calls); // окно закрыто консервативно: без «Джарвис» не принято
    await say("Джарвис, продолжай"); // одно обращение возвращает диалог
    expect(onUserTurn).toHaveBeenLastCalledWith("продолжай", expect.anything());
    await say("и дальше без обращения"); // тихо (счётчик пуст) → окно снова мягкое, как прежде
    expect(onUserTurn).toHaveBeenLastCalledWith("и дальше без обращения", expect.anything());
  });

  it("акустика (ревью #1): одна реплика через gateWake ДВАЖДЫ (спекулятивный эндпоинт + поздний финал) = ОДИН сигнал шума", async () => {
    // Прод-паттерн: спекулятивный эндпоинт финализирует interim, а закрытие стрима досылает поздний
    // реальный финал → gateWake проходится дважды НА ОДНОМ ходе. Без дедупа по turnSeq порог «3 реплики»
    // срабатывал на 2 фразах, а exit-гистерезис 1 был недостижим (1 фраза = 2 записи, режим залипал).
    const { pipe, stt, onUserTurn, say } = setup(10_000);
    for (const text of ["фон номер один", "фон номер два"]) {
      pipe.onWake();
      const s = stt.last!;
      s.emit({ text, final: true }); // «спекулятивный» проход
      await flush();
      s.emit({ text, final: true }); // поздний финал ТОГО ЖЕ стрима/хода — считаться не должен
      await flush();
    }
    // 2 физические реплики = 2 сигнала (не 4) → порог 3 НЕ достигнут, окно разговора живо
    await say("Джарвис, привет");
    await say("продолжение без обращения");
    expect(onUserTurn).toHaveBeenLastCalledWith("продолжение без обращения", expect.anything());
  });

  it("акустика (ревью р2): запоздавший финал СТАРОГО хода, пришедший ПОСЛЕ учтённого нового, не считается повторно", async () => {
    // Деградированная сеть: flush Deepgram хода N задержался дольше целого следующего хода. Скалярный
    // маркер `!==` считал бы такой финал заново (маркер уже перезаписан ходом N+1) — сравнение строго
    // по возрастанию (turnSeq монотонный) отбрасывает финалы прошлых ходов.
    const { pipe, stt, onUserTurn, say } = setup(10_000);
    pipe.onWake();
    const s1 = stt.last!;
    s1.emit({ text: "фон номер один", final: true }); // ход 1 учтён
    await flush();
    pipe.onWake();
    const s2 = stt.last!;
    expect(s2).not.toBe(s1); // новый ход — новый стрим
    s2.emit({ text: "фон номер два", final: true }); // ход 2 учтён (маркер перезаписан)
    await flush();
    s1.emit({ text: "фон номер один", final: true }); // запоздавший финал хода 1 — фантом, НЕ считать
    await flush();
    await say("Джарвис, привет");
    await say("продолжение без обращения"); // сигналов 2 (не 3) → строгий режим не взведён
    expect(onUserTurn).toHaveBeenLastCalledWith("продолжение без обращения", expect.anything());
  });

  it("акустика (ревью #2): фон при живом диалоге — masked-exit закрывает окно, фон НЕ принимается командой, повторный вход работает", async () => {
    // Целевой сценарий фичи: фильм/ТВ говорит непрерывно, владелец командует с «Джарвис». Раньше распад
    // счётчика (заблокированные реплики не считаются) выключал режим с ложным «стихла», следующая фраза
    // фильма ПРИНИМАЛАСЬ командой, катила окно от чужой речи, и режим не мог вернуться никогда.
    const { onUserTurn, advance, say } = setup(60_000);
    await say("фон один"); // t=0: три фразы при закрытом окне → строгий режим
    await say("фон два");
    await say("фон три");
    await say("Джарвис, сделай громче"); // принято, окно открыто
    const calls = onUserTurn.mock.calls.length;
    advance(10_000); // t=10
    await say("звук фильма продолжает идти"); // блок строгим режимом → маркер маскировки
    advance(24_000); // t=34: фоновые записи (t=0) истекли, маркер (t=10) ещё в окне
    await say("какая-то фраза фильма"); // masked-exit: режим снят + окно ЗАКРЫТО → НЕ принята, но СЧИТАЕТСЯ (окно закрыто)
    expect(onUserTurn).toHaveBeenCalledTimes(calls); // ничего из фона командой не ушло
    advance(1_000); // t=35
    await say("снова фраза фильма"); // счётчик: 2
    advance(1_000); // t=36
    await say("опять фраза фильма"); // счётчик: 3 → строгий режим ВЕРНУЛСЯ (повторный вход жив)
    expect(onUserTurn).toHaveBeenCalledTimes(calls);
    await say("Джарвис, стоп"); // владелец пробуждается штатно и в шуме
    expect(onUserTurn).toHaveBeenLastCalledWith("стоп", expect.anything());
  });

  it("акустика (ревью #6): near-miss попытки докричаться («Дарья…») НЕ копят зашумлённость — это владелец, не фон", async () => {
    const { onUserTurn, say } = setup(10_000);
    await say("Дарья, запусти поиск в доте"); // lev 4 от «джарвис» — похоже на обращение, не шум
    await say("Дарья, запусти поиск снова");
    await say("Дарья, ну запусти же поиск");
    await say("Джарвис, поставь музыку"); // наконец расслышал
    await say("а теперь громче"); // окно принимает: строгий режим от его же попыток НЕ включился
    expect(onUserTurn).toHaveBeenLastCalledWith("а теперь громче", expect.anything());
  });

  it("акустика (ревью #10): чистые междометия при закрытом окне НЕ копят зашумлённость", async () => {
    const { onUserTurn, say } = setup(10_000);
    await say("ах"); // isNoiseOnly: навредить не может ни в каком окне — не сигнал шума
    await say("ох");
    await say("хм");
    await say("Джарвис, привет");
    await say("продолжим без обращения"); // тихая комната осталась тихой
    expect(onUserTurn).toHaveBeenLastCalledWith("продолжим без обращения", expect.anything());
  });

  it("§P0: мозг получает viaWake — true на «Джарвис»/без wake-гейта, false на реплику из окна разговора", async () => {
    // Гейт авто-реплея (форензика 2026-07-14): чужая речь входит через катящееся окно — мозг обязан
    // знать, что реплика принята БЕЗ явного обращения, и не давать ей слепые жесты.
    const { onUserTurn, say } = setup(10_000);
    await say("Джарвис, закрой приложение");
    expect(onUserTurn).toHaveBeenLastCalledWith("закрой приложение", { viaWake: true });
    await say("а теперь сверни окно"); // принято ОКНОМ без «Джарвис»
    expect(onUserTurn).toHaveBeenLastCalledWith("а теперь сверни окно", { viaWake: false });
  });

  it("акустика (ревью р2): зона гистерезиса — частичный распад до n=2 (между exit=1 и enter=3) ДЕРЖИТ строгий режим", async () => {
    const { onUserTurn, advance, say } = setup(60_000);
    await say("фон один"); // t=0
    advance(15_000); // t=15
    await say("фон два");
    await say("фон три"); // n=3 → строгий режим ВКЛ
    await say("Джарвис, поставь паузу"); // окно открыто (t=15)
    const calls = onUserTurn.mock.calls.length;
    advance(17_000); // t=32: запись t=0 истекла (>30с), t=15 живы → n=2 — внутри зоны [2,2]
    await say("всё ещё без обращения"); // n=2 > exit(1) → режим НЕ спал, реплика блокируется
    expect(onUserTurn).toHaveBeenCalledTimes(calls);
  });

  it("акустика (ревью р2): ЧИСТЫЙ выход (в окне ничего не блокировалось) — окно разговора СОХРАНЯЕТСЯ", async () => {
    // Различие веток выхода — суть masked-exit: закрываем окно ТОЛЬКО когда сигнал был маскирован
    // (blockedAt непуст). Владелец молчал в окне → тишина ДОКАЗАНА распадом → окно живо, как раньше.
    const { onUserTurn, advance, say } = setup(60_000);
    await say("фон один"); // t=0, ×3 → строгий режим
    await say("фон два");
    await say("фон три");
    await say("Джарвис, поставь паузу"); // окно открыто; дальше владелец МОЛЧИТ (blockedAt пуст)
    advance(31_000); // t=31: фоновые записи истекли, маскировки не было → чистый выход «стихла»
    await say("продолжай без обращения"); // окно уцелело (60с) → принято сразу
    expect(onUserTurn).toHaveBeenLastCalledWith("продолжай без обращения", expect.anything());
  });

  it("акустика (ревью р2): кривой JARVIS_NOISY_MIN_IGNORED=0 клампится с WARN — тихая комната НЕ глохнет", async () => {
    const prevMin = process.env.JARVIS_NOISY_MIN_IGNORED;
    process.env.JARVIS_NOISY_MIN_IGNORED = "0"; // «0 = выкл» по конвенции проекта — но здесь это дало бы вход n≥0 = ВСЕГДА
    vi.resetModules();
    try {
      const { VoicePipeline: FreshPipeline } = await import("./pipeline.js");
      let clock = 0;
      const stt = new CtrlSttProvider();
      const tts = new CtrlTtsProvider();
      const warns: string[] = [];
      const onUserTurn = vi.fn(async () => ({ voice: "Готово." }));
      const pipe = new FreshPipeline({
        stt,
        tts,
        onUserTurn,
        sendSpeakChunk: () => {},
        sendClientState: () => {},
        requireWakeWord: true,
        conversationWindowMs: 10_000,
        followupMs: 1_000_000,
        now: () => clock,
        log: {
          info: () => {},
          warn: (m: string) => {
            warns.push(m);
          },
          error: () => {},
          debug: () => {},
        } as never,
      });
      expect(warns.some((m) => m.includes("кривая конфигурация JARVIS_NOISY_"))).toBe(true);
      const say = async (text: string) => {
        pipe.onWake();
        stt.last!.emit({ text, final: true });
        await flush();
        if (tts.last) {
          tts.last.push(0, true);
          tts.last.finish();
          await flush();
        }
      };
      await say("Джарвис, привет");
      await say("а как дела"); // MIN клампнут до 1 → в ТИШИНЕ режим не взводится, окно живо
      expect(onUserTurn).toHaveBeenLastCalledWith("а как дела", expect.anything());
    } finally {
      if (prevMin === undefined) delete process.env.JARVIS_NOISY_MIN_IGNORED;
      else process.env.JARVIS_NOISY_MIN_IGNORED = prevMin;
      vi.resetModules();
    }
  });

  it("выключатель JARVIS_STRICT_WAKE_IN_NOISE=0 → строгий wake не включается даже в шуме", async () => {
    const prev = process.env.JARVIS_STRICT_WAKE_IN_NOISE;
    process.env.JARVIS_STRICT_WAKE_IN_NOISE = "0";
    try {
      const { onUserTurn, say } = setup(10_000);
      await say("фон один");
      await say("фон два");
      await say("фон три");
      await say("Джарвис, привет");
      await say("а дальше без обращения"); // строгий wake ВЫКЛ → окно принимает
      expect(onUserTurn).toHaveBeenLastCalledWith("а дальше без обращения", expect.anything());
    } finally {
      if (prev === undefined) delete process.env.JARVIS_STRICT_WAKE_IN_NOISE;
      else process.env.JARVIS_STRICT_WAKE_IN_NOISE = prev;
    }
  });

  // Ревью #11: гейт «second-chance подавляется в шуме» был заявлен фичей, но не покрыт ни одним тестом
  // (в setup() выше hasActiveTask не передаётся — ветка недостижима). Свой сетап: активная задача +
  // перехват текстов синтеза (переспрос «Вы мне, сэр?» идёт через speakQueued → TTS).
  function setupSecondChance() {
    let clock = 0;
    const stt = new CtrlSttProvider();
    const spoken: string[] = [];
    const tts = {
      live: false,
      synthesize: (text: string) => {
        spoken.push(text);
        return new CtrlTtsStream();
      },
    } as unknown as ITtsProvider;
    const onUserTurn = vi.fn(async () => ({ voice: "Готово." }));
    const pipe = new VoicePipeline({
      stt,
      tts,
      onUserTurn,
      sendSpeakChunk: () => {},
      sendClientState: () => {},
      requireWakeWord: true,
      conversationWindowMs: 10_000,
      followupMs: 1_000_000,
      hasActiveTask: () => true,
      now: () => clock,
    });
    const advance = (ms: number) => {
      clock += ms;
    };
    const say = async (text: string) => {
      pipe.onWake();
      stt.last!.emit({ text, final: true });
      await flush();
    };
    return { pipe, spoken, advance, say };
  }

  it("second-chance: в ТИШИНЕ near-miss при активной задаче → переспрос «Вы мне, сэр?» звучит (контроль ветки)", async () => {
    const { spoken, advance, say } = setupSecondChance();
    advance(130_000); // за кулдаун second-chance (120с от t=0)
    await say("Дарья, запусти поиск в доте"); // near-miss (lev 4), тишина → переспрос
    expect(spoken).toContain("Вы мне, сэр?");
  });

  it("second-chance: в ШУМЕ переспрос ПОДАВЛЯЕТСЯ (не «Вы мне?» на фоновую болтовню)", async () => {
    const { spoken, advance, say } = setupSecondChance();
    advance(130_000); // кулдаун заведомо пройден — подавлять может ТОЛЬКО шумовой гейт
    await say("фон один"); // 3 неадресованные → строгий режим
    await say("фон два");
    await say("фон три");
    await say("Дарья, запусти поиск в доте"); // near-miss в шуме → тихий дроп, без переспроса
    expect(spoken).not.toContain("Вы мне, сэр?");
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
    expect(onUserTurn).toHaveBeenCalledWith("какая погода", expect.anything());
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

describe("VoicePipeline — earcon раздумья на sync-first (§P1, форензика 2026-07-14)", () => {
  const setEnv = (v: string | undefined) => {
    if (v === undefined) delete process.env.JARVIS_THINK_EARCON_MS;
    else process.env.JARVIS_THINK_EARCON_MS = v;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Earcon — WAV-буфер (сотни байт); мок-TTS шлёт 1-байтные чанки — различаем по размеру. */
  const earconsOf = (chunks: TtsChunk[]) => chunks.filter((c) => c.audio.byteLength > 100);

  it("молчание раздумья дольше порога → ОДИН earcon-тик, состояние машины не тронуто", async () => {
    const prev = process.env.JARVIS_THINK_EARCON_MS;
    setEnv("30");
    try {
      let resolveReply: (r: { voice: string }) => void = () => {};
      const slow = vi.fn(() => new Promise<{ voice: string }>((r) => (resolveReply = r)));
      const { pipe, stt, tts, chunks } = makePipeline(slow);
      pipe.onWake();
      stt.last!.emit({ text: "который час", final: true });
      await flush();
      expect(pipe.state).toBe("thinking");
      await sleep(70); // > порога 30мс — мозг всё ещё думает
      expect(earconsOf(chunks)).toHaveLength(1); // тик «услышал, думаю» прозвучал
      expect(pipe.state).toBe("thinking"); // это не речь — машина состояний не тронута
      resolveReply({ voice: "Готово." });
      await flush();
      tts.last!.push(0, true); // реальный ответ штатно играет после тика
      tts.last!.finish();
      expect(earconsOf(chunks)).toHaveLength(1); // тик был один
    } finally {
      setEnv(prev);
    }
  });

  it("быстрый ответ раньше порога → тик НЕ звучит", async () => {
    const prev = process.env.JARVIS_THINK_EARCON_MS;
    setEnv("60");
    try {
      const { pipe, stt, tts, chunks } = makePipeline();
      pipe.onWake();
      stt.last!.emit({ text: "который час", final: true });
      await flush();
      tts.last!.push(0, true); // ответ уже играет (speaking)
      await sleep(90); // таймер тика сработал бы здесь — но звук уже пошёл
      expect(earconsOf(chunks)).toHaveLength(0);
      tts.last!.finish();
    } finally {
      setEnv(prev);
    }
  });

  it("СТРИМИНГОВЫЙ прод-путь (ревью, HIGH): earcon звучит, пока PhraseSpeaker ещё не заговорил", async () => {
    // Гард по phraseSpeaker.active глушил тик ВЕСЬ стриминговый ход: спикер создаётся ДО вызова brain
    // и active=true с конструирования — фича была мертва ровно на прод-дефолте (onUserTurnStream).
    const prev = process.env.JARVIS_THINK_EARCON_MS;
    setEnv("30");
    try {
      const stt = new CtrlSttProvider();
      const tts = new CtrlTtsProvider();
      const chunks: TtsChunk[] = [];
      const pipe = new VoicePipeline({
        stt,
        tts,
        onUserTurn: async () => ({ voice: "не используется" }),
        onUserTurnStream: () => new Promise<void>(() => {}), // brain думает бесконечно, ни одной фразы
        sendSpeakChunk: (c) => chunks.push(c),
        sendClientState: () => {},
        followupMs: 1_000_000,
      });
      pipe.onWake();
      stt.last!.emit({ text: "запусти поиск", final: true });
      await flush();
      expect(pipe.state).toBe("thinking");
      await sleep(70); // > порога 30мс — фраз от brain так и нет
      expect(earconsOf(chunks)).toHaveLength(1); // тик прозвучал и на пофразном пути
    } finally {
      setEnv(prev);
    }
  });

  it("stop/barge-in во время раздумья отменяет тик; выключатель 0 — тика нет вовсе", async () => {
    const prev = process.env.JARVIS_THINK_EARCON_MS;
    setEnv("30");
    try {
      const slow = vi.fn(() => new Promise<{ voice: string }>(() => {}));
      const { pipe, stt, chunks } = makePipeline(slow);
      pipe.onWake();
      stt.last!.emit({ text: "который час", final: true });
      await flush();
      pipe.stop(); // оборвали ход, пока думал
      await sleep(60);
      expect(earconsOf(chunks)).toHaveLength(0);
      // выключатель: 0 = тик не взводится
      setEnv("0");
      const second = makePipeline(vi.fn(() => new Promise<{ voice: string }>(() => {})));
      second.pipe.onWake();
      second.stt.last!.emit({ text: "который час", final: true });
      await flush();
      await sleep(40);
      expect(earconsOf(second.chunks)).toHaveLength(0);
    } finally {
      setEnv(prev);
    }
  });
});

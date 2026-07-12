/**
 * §10 realtime: клиентская ОЧЕРЕДЬ воспроизведения. Реплика приходит несколькими
 * озвучками (по предложению) — они должны играть ПОДРЯД (а не обрывать друг друга),
 * а barge-in/stop — глушить текущую и чистить очередь. Плеер инъектируется (без DOM).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioCapture, AudioPlayback, type PlayerFactory, type Utterance } from "./audio.js";

/** Базовая base64 одного-двух байт (atob в base64ToBytes — нодовский глобал). */
const b64 = (bytes: number[]): string => Buffer.from(bytes).toString("base64");

class FakePlayer {
  stopped = false;
  constructor(
    readonly bytes: Uint8Array,
    readonly onEnded: () => void,
  ) {}
}

function harness() {
  const players: FakePlayer[] = [];
  const factory: PlayerFactory = (bytes, onEnded, onPlaying): Utterance => {
    const p = new FakePlayer(bytes, onEnded);
    players.push(p);
    onPlaying?.(); // симулируем <audio> onplaying (звук РЕАЛЬНО пошёл) — для mouth-to-ear ack
    return {
      stop() {
        p.stopped = true;
      },
    };
  };
  return { pb: new AudioPlayback(factory), players };
}

describe("AudioPlayback очередь (§10)", () => {
  it("две озвучки реплики играют ПОДРЯД, не обрывая друг друга", () => {
    const { pb, players } = harness();
    pb.enqueue({ audio: b64([1]), seq: 0, last: true }); // фраза 1 → играет
    expect(players).toHaveLength(1);
    pb.enqueue({ audio: b64([2]), seq: 0, last: true }); // фраза 2 → в очередь
    expect(players).toHaveLength(1);
    expect(players[0]!.stopped).toBe(false); // первую НЕ оборвали

    players[0]!.onEnded(); // первая доиграла → стартует вторая
    expect(players).toHaveLength(2);
    expect(players[1]!.bytes[0]).toBe(2);
  });

  it("многочанковая озвучка склеивается и играется одним буфером", () => {
    const { pb, players } = harness();
    pb.enqueue({ audio: b64([10, 11]), seq: 0, last: false });
    pb.enqueue({ audio: b64([12]), seq: 1, last: true });
    expect(players).toHaveLength(1);
    expect(Array.from(players[0]!.bytes)).toEqual([10, 11, 12]);
  });

  it("barge-in/stop глушит текущую и чистит очередь", () => {
    const { pb, players } = harness();
    pb.enqueue({ audio: b64([1]), seq: 0, last: true });
    pb.enqueue({ audio: b64([2]), seq: 0, last: true }); // в очереди
    pb.stop();
    expect(players[0]!.stopped).toBe(true);
    // очередь очищена — окончание текущей НЕ запускает «фразу 2»
    players[0]!.onEnded();
    expect(players).toHaveLength(1);
  });

  it("пустой чанк без last ничего не запускает; last без байтов не падает", () => {
    const { pb, players } = harness();
    pb.enqueue({ audio: "", seq: 0, last: false });
    expect(players).toHaveLength(0);
    pb.enqueue({ audio: "", seq: 0, last: true }); // нет накопленных байтов → нет озвучки
    expect(players).toHaveLength(0);
  });

  it("новая реплика после доигрывания предыдущей стартует сразу", () => {
    const { pb, players } = harness();
    pb.enqueue({ audio: b64([1]), seq: 0, last: true });
    players[0]!.onEnded(); // доиграла, очередь пуста, current=null
    pb.enqueue({ audio: b64([2]), seq: 0, last: true });
    expect(players).toHaveLength(2);
    expect(players[1]!.bytes[0]).toBe(2);
  });

  // Ревью Волны 3 (#16): PCM-фраза, чьи чанки копятся, пока играет ПРЕДЫДУЩАЯ, НЕ теряет голову, если
  // предыдущая доиграла посреди приёма. Раньше следующий чанк создавал новый live-плеер (только хвост);
  // теперь идёт в накопитель → на last собирается ЦЕЛЬНАЯ WAV-озвучка. (AudioContext в тест-среде нет —
  // ошибочный путь создал бы live-плеер и упал бы, что само по себе ловит регрессию.)
  it("(#16) PCM-голова не теряется при доигрывании предыдущей фразы посреди приёма", () => {
    const { pb, players } = harness();
    pb.enqueue({ audio: b64([1]), seq: 0, last: true }); // фраза 1 (mp3) играет, current занят
    expect(players).toHaveLength(1);
    pb.enqueue({ audio: b64([10, 11]), seq: 0, last: false, format: "pcm16" }); // голова фразы 2 копится
    players[0]!.onEnded(); // фраза 1 доиграла ПОСРЕДИ приёма фразы 2 → current=null, очередь пуста
    pb.enqueue({ audio: b64([12, 13]), seq: 1, last: false, format: "pcm16" }); // ещё чанк — в накопитель, не новый плеер
    pb.enqueue({ audio: "", seq: 2, last: true, format: "pcm16" }); // last → цельная WAV-озвучка в очередь
    expect(players).toHaveLength(2);
    const wav = players[1]!.bytes;
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF"); // собрано как WAV
    expect([...wav.slice(44)]).toEqual([10, 11, 12, 13]); // голова+хвост целиком, ничего не потеряно
  });

  // Ревью Волны 3 (#18): «отставший» чанк отменённой фразы, пришедший сразу ПОСЛЕ barge-in/stop, не
  // должен зазвучать (в v3 он создавал новый live-плеер поверх речи юзера). Окно подавления ~400мс.
  it("(#18) отставший чанк после stop() не запускает воспроизведение", () => {
    const { pb, players } = harness();
    pb.enqueue({ audio: b64([1]), seq: 0, last: true });
    pb.stop(); // barge-in
    pb.enqueue({ audio: b64([9]), seq: 0, last: true }); // straggler в окне подавления → дропаем
    expect(players).toHaveLength(1); // новая озвучка не стартовала
  });
});

// Realtime инкремент 0: mouth-to-ear ack — при РЕАЛЬНОМ старте первого звука хода рендерер зовёт
// onFirstAudioPlayed(gen, ts) РОВНО ОДИН раз на ход (дедуп по gen). Сервер меряет «конец речи → звук».
describe("AudioPlayback — mouth-to-ear ack (инкремент 0)", () => {
  function harnessAck() {
    const players: FakePlayer[] = [];
    const factory: PlayerFactory = (bytes, onEnded, onPlaying): Utterance => {
      const p = new FakePlayer(bytes, onEnded);
      players.push(p);
      onPlaying?.(); // <audio> onplaying → mouth-to-ear ack (по реальному старту, не по dequeue)
      return { stop() { p.stopped = true; } };
    };
    const played: Array<{ gen: number; ts: number }> = [];
    const pb = new AudioPlayback(factory, undefined, (gen, ts) => played.push({ gen, ts }));
    return { pb, players, played };
  }

  it("первый звук хода → ack(gen) ОДИН раз; следующая озвучка того же хода — без второго ack", () => {
    const { pb, players, played } = harnessAck();
    pb.enqueue({ audio: b64([1]), seq: 0, last: true, gen: 5 }); // ход 5 стартовал играть
    expect(played).toHaveLength(1);
    expect(played[0]!.gen).toBe(5);
    pb.enqueue({ audio: b64([2]), seq: 0, last: true, gen: 5 }); // вторая фраза того же хода → в очередь
    players[0]!.onEnded(); // она стартует
    expect(played).toHaveLength(1); // тот же ход 5 — второго ack НЕТ (дедуп)
  });

  it("новый ход (другой gen) → новый ack", () => {
    const { pb, players, played } = harnessAck();
    pb.enqueue({ audio: b64([1]), seq: 0, last: true, gen: 5 });
    pb.enqueue({ audio: b64([2]), seq: 0, last: true, gen: 6 }); // ход 6 в очередь (ход 5 ещё играет)
    players[0]!.onEnded(); // ход 5 доиграл → стартует ход 6
    expect(played.map((p) => p.gen)).toEqual([5, 6]);
  });

  it("чанк без gen — ack не шлём (старый сервер/нетегированный звук)", () => {
    const { pb, played } = harnessAck();
    pb.enqueue({ audio: b64([1]), seq: 0, last: true }); // gen отсутствует
    expect(played).toHaveLength(0);
  });

  it("ревью #1: наложение ходов без barge — ack атрибутируется ЕГО озвучке, не последнему чанку", () => {
    const { pb, players, played } = harnessAck();
    // ход 5: две фразы; ход 6 приходит ПОКА играет ход 5 (проактив/speakQueued, без stop())
    pb.enqueue({ audio: b64([1]), seq: 0, last: true, gen: 5 }); // фраза1 хода5 играет → ack 5
    pb.enqueue({ audio: b64([2]), seq: 0, last: true, gen: 5 }); // фраза2 хода5 → в очередь (несёт gen5)
    pb.enqueue({ audio: b64([3]), seq: 0, last: true, gen: 6 }); // ход6 → в очередь (несёт gen6)
    expect(played.map((p) => p.gen)).toEqual([5]); // играет только ход5
    players[0]!.onEnded(); // фраза1 доиграла → фраза2 (gen5) стартует → дедуп, НЕ преждевременный ack 6
    expect(played.map((p) => p.gen)).toEqual([5]);
    players[1]!.onEnded(); // фраза2 доиграла → озвучка хода6 стартует → ТЕПЕРЬ ack 6 (в свой реальный старт)
    expect(played.map((p) => p.gen)).toEqual([5, 6]);
  });
});

/**
 * H18 (ревью 2026-07-02): «оглох навсегда». Watchdog реинитил захват по mute/ended, но если
 * start() падал (игра держит устройство → getUserMedia кидает NotReadableError), трек уже был
 * убит stop() → события больше НЕ приходили, таймеров не было → тишина до перезапуска клиента.
 * Теперь restart() чинит себя таймером-ретраем с бэкоффом. Браузерные глобалы — заглушки.
 */
class FakeTrack {
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  stop = vi.fn();
}

class FakeStream {
  constructor(public track = new FakeTrack()) {}
  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeWorkletNode {
  port = { onmessage: null as unknown, close: vi.fn() };
  connect = vi.fn();
}

class FakeAudioContext {
  state = "running";
  onstatechange: (() => void) | null = null;
  audioWorklet = { addModule: vi.fn(async () => {}) };
  destination = {};
  createMediaStreamSource(): { connect: ReturnType<typeof vi.fn> } {
    return { connect: vi.fn() };
  }
  createWaveShaper(): { connect: ReturnType<typeof vi.fn>; curve: unknown; oversample: string } {
    return { connect: vi.fn(), curve: null, oversample: "" };
  }
  createGain(): { gain: { value: number }; connect: ReturnType<typeof vi.fn> } {
    return { gain: { value: 0 }, connect: vi.fn() };
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("AudioCapture — само-лечение захвата (H18)", () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  let streams: FakeStream[];

  beforeEach(() => {
    vi.useFakeTimers();
    streams = [];
    getUserMedia = vi.fn(async () => {
      const s = new FakeStream();
      streams.push(s);
      return s as unknown as MediaStream;
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("устройство занято при реините → таймер-ретрай с бэкоффом возвращает слух (не глохнет навсегда)", async () => {
    const cap = new AudioCapture(() => {});
    await cap.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // Игра забрала устройство: трек кончился, а реинит падает — устройство ещё не отдали.
    getUserMedia
      .mockRejectedValueOnce(new Error("NotReadableError"))
      .mockRejectedValueOnce(new Error("NotReadableError"));
    streams[0]!.track.onended?.();
    await vi.advanceTimersByTimeAsync(0); // restart(): stop → start (падает) → армируется ретрай 1с
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000); // ретрай №1 — всё ещё занято → бэкофф 2с
    expect(getUserMedia).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(2000); // ретрай №2 — устройство отдали → захват ожил
    expect(getUserMedia).toHaveBeenCalledTimes(4);
    const last = streams.at(-1)!;
    expect(last.track.onended).toBeTypeOf("function"); // watchdog заново повешен на живой трек
  });

  it("stop() отменяет запланированный ретрай (ручная остановка не оживает сама)", async () => {
    const cap = new AudioCapture(() => {});
    await cap.start();
    getUserMedia.mockRejectedValue(new Error("NotReadableError"));
    streams[0]!.track.onended?.();
    await vi.advanceTimersByTimeAsync(0); // ретрай армирован
    const calls = getUserMedia.mock.calls.length;
    await cap.stop(); // пользователь/приложение остановили захват
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getUserMedia).toHaveBeenCalledTimes(calls); // ретраи не тикают после stop()
  });
});

/**
 * Ревью фиксов Волны 3 (#6, #7/#13): PCM-стрим v3 — сироты накопителя и дренаж-вотчдог живого плеера.
 * AudioContext для PcmLivePlayer — заглушка (WebAudio в тест-среде нет).
 */
class FakeBufferSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
}

class FakePcmAudioContext {
  static instances: FakePcmAudioContext[] = [];
  currentTime = 0;
  destination = {};
  closed = false;
  sources: FakeBufferSource[] = [];
  constructor(_opts?: unknown) {
    FakePcmAudioContext.instances.push(this);
  }
  createGain(): { connect: ReturnType<typeof vi.fn>; gain: { value: number } } {
    return { connect: vi.fn(), gain: { value: 1 } };
  }
  createBuffer(_ch: number, len: number, rate: number): { duration: number; copyToChannel: ReturnType<typeof vi.fn> } {
    return { duration: len / rate, copyToChannel: vi.fn() };
  }
  createBufferSource(): FakeBufferSource {
    const s = new FakeBufferSource();
    this.sources.push(s);
    return s;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("PCM-стрим v3: сироты и дренаж (ревью фиксов #6/#7)", () => {
  beforeEach(() => {
    vi.useFakeTimers(); // мокает и Date.now — пауза потока двигается advanceTimersByTime
    FakePcmAudioContext.instances = [];
    vi.stubGlobal("AudioContext", FakePcmAudioContext);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("(#6) осиротевшие чанки оборванного стрима НЕ склеиваются со следующей фразой", () => {
    const { pb, players } = harness();
    pb.enqueue({ audio: b64([1]), seq: 0, last: true }); // mp3 играет → pcm копится busy-путём
    pb.enqueue({ audio: b64([101, 102]), seq: 0, last: false, format: "pcm16" }); // фраза A; last потерян (обрыв WS)
    vi.advanceTimersByTime(13_000); // пауза больше порога сироты (12с) — прошлый стрим мёртв
    pb.enqueue({ audio: b64([7, 8]), seq: 0, last: false, format: "pcm16" }); // фраза B
    pb.enqueue({ audio: "", seq: 1, last: true, format: "pcm16" });
    players[0]!.onEnded(); // mp3 доиграла → из очереди стартует WAV фразы B
    expect(players).toHaveLength(2);
    // WAV фразы B — БЕЗ головы мёртвой фразы A (раньше юзер слышал обрывок отменённой реплики).
    expect([...players[1]!.bytes.slice(44)]).toEqual([7, 8]);
  });

  it("(#6) живой поток (пауза меньше порога) не трогается — чанки одной фразы склеиваются", () => {
    const { pb, players } = harness();
    pb.enqueue({ audio: b64([1]), seq: 0, last: true }); // канал занят
    pb.enqueue({ audio: b64([10, 11]), seq: 0, last: false, format: "pcm16" });
    vi.advanceTimersByTime(2_000); // обычная пауза между чанками синтеза
    pb.enqueue({ audio: b64([12, 13]), seq: 1, last: true, format: "pcm16" });
    players[0]!.onEnded(); // канал освободился → WAV фразы стартует из очереди
    expect(players).toHaveLength(2);
    expect([...players[1]!.bytes.slice(44)]).toEqual([10, 11, 12, 13]);
  });

  // Ревью 2-го прохода (R5): сервер после своего inactivity-аборта (8с) шлёт ЧЕСТНЫЙ частичный last —
  // он приходит позже любой паузы, но принадлежит тому же стриму: партиал обязан прозвучать.
  it("(R5) поздний частичный last после долгой паузы НЕ съедается сиротским сбросом", () => {
    const { pb, players } = harness();
    pb.enqueue({ audio: b64([1]), seq: 0, last: true }); // канал занят
    pb.enqueue({ audio: b64([21, 22]), seq: 0, last: false, format: "pcm16" }); // партиал фразы
    vi.advanceTimersByTime(13_000); // Yandex замолчал; сервер абортится по inactivity и шлёт last
    pb.enqueue({ audio: "", seq: 1, last: true, format: "pcm16" }); // честный «что успели — то и есть»
    players[0]!.onEnded();
    expect(players).toHaveLength(2); // партиал прозвучал (раньше mergeParts([]) молча терял его)
    expect([...players[1]!.bytes.slice(44)]).toEqual([21, 22]);
  });

  it("(#7/#13) вырожденный чанк (байт в carry) не снимает дренаж-вотчдог навсегда", () => {
    const { pb } = harness();
    // Простой → первый pcm-чанк создаёт живой плеер (заглушка AudioContext).
    pb.enqueue({ audio: b64([1, 2]), seq: 0, last: false, format: "pcm16" });
    const ctx = FakePcmAudioContext.instances.at(-1)!;
    expect(ctx.sources).toHaveLength(1);
    ctx.sources[0]!.onended?.(); // хвост доигран; last не было → взведён дренаж-вотчдог (#17)
    // Вырожденный чанк умершего стрима: единственный байт уходит в carry, источник НЕ создаётся —
    // раньше clearDrainTimer в начале feed() снимал вотчдог БЕЗ повторного взвода → канал зависал.
    pb.enqueue({ audio: b64([9]), seq: 1, last: false, format: "pcm16" });
    expect(ctx.sources).toHaveLength(1); // источника из carry-чанка нет
    vi.advanceTimersByTime(11_500); // > DRAIN_IDLE_MS (11с; поднят выше серверного INACTIVITY_MS, #3)
    expect(ctx.closed).toBe(true); // плеер завершился по дренажу — barge-окно не залипло
  });
});

// §Волна3 (3.5): WAV-обёртка сырого PCM16 — заголовок RIFF корректен, данные не искажаются.
describe("wavFromPcm16 (§Волна3 3.5)", () => {
  it("строит валидный WAV-заголовок и сохраняет PCM-байты", async () => {
    const { wavFromPcm16 } = await import("./audio.js");
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const wav = wavFromPcm16(pcm, 22_050);
    const txt = (o: number, n: number): string => String.fromCharCode(...wav.slice(o, o + n));
    expect(txt(0, 4)).toBe("RIFF");
    expect(txt(8, 4)).toBe("WAVE");
    expect(txt(36, 4)).toBe("data");
    const dv = new DataView(wav.buffer);
    expect(dv.getUint32(24, true)).toBe(22_050); // sampleRate
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(40, true)).toBe(6); // размер данных
    expect([...wav.slice(44)]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

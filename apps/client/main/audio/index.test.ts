import type { Logger } from "@jarvis/shared";
import { describe, expect, it, vi } from "vitest";
import type { IVad, VadSignal } from "../vad/index.js";
import type { IWakeWord } from "../wakeword/index.js";
import { AudioCoordinator } from "./index.js";

const loud = (): Int16Array => new Int16Array(160).fill(6000);
/** Умеренный уровень (rms 450): ниже старого порога barge 600, выше нового 350 — должен перебивать. */
const moderate = (): Int16Array => new Int16Array(160).fill(450);
/** Прогнать onsetFrames громких кадров — устойчивая речь, чтобы VAD дал speech_start (анти-дребезг). */
const speak = (ac: { ingest(p: Int16Array): void }, frames = 3): void => {
  for (let i = 0; i < frames; i += 1) ac.ingest(loud());
};
/**
 * Устойчивая речь ПО ВРЕМЕНИ для barge (fix 2026-07-15): barge теперь требует непрерывного превышения
 * порога ≥BARGE_SUSTAIN_MS (200мс), а не N кадров. В проде кадры приходят во времени (~10мс/кадр) — тут
 * двигаем часы ~60мс/кадр, 5 кадров = 300мс > 200 → устойчивый barge.
 */
const bargeSpeak = (
  ac: { ingest(p: Int16Array): void },
  advance: (ms: number) => void,
  frameFn: () => Int16Array = loud,
): void => {
  for (let i = 0; i < 5; i += 1) {
    ac.ingest(frameFn());
    advance(60);
  }
};

function setup(wakeword?: IWakeWord, extra: { vad?: IVad; log?: Logger } = {}) {
  const sendFrame = vi.fn();
  const sendVad = vi.fn();
  const onMicState = vi.fn();
  const onBargeIn = vi.fn();
  let clock = 0;
  const advance = (ms: number): void => {
    clock += ms;
  };
  const ac = new AudioCoordinator({ sendFrame, sendVad, onMicState, onBargeIn, wakeword, now: () => clock, ...extra });
  return { ac, sendFrame, sendVad, onMicState, onBargeIn, advance };
}

/** Управляемый VAD: тест сам решает, идёт ли речь и какой сигнал выдать на следующем кадре. */
class ScriptVad implements IVad {
  speaking = false;
  private next: VadSignal = null;
  reset = vi.fn(() => {
    this.speaking = false;
  });
  say(): void {
    this.speaking = true;
    this.next = "speech_start";
  }
  hush(): void {
    this.speaking = false;
    this.next = "speech_end";
  }
  process(_pcm: Int16Array): VadSignal {
    const s = this.next;
    this.next = null;
    return s;
  }
}

/** Логгер-шпион (телеметрия промаха wake пишет через deps.log). */
function spyLog(): Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => l };
  return l as unknown as Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
}

describe("AudioCoordinator (§3, §0.6)", () => {
  it("privacy-гейт: без активации аудио на сервер НЕ уходит", () => {
    const { ac, sendFrame, sendVad } = setup();
    ac.ingest(loud());
    ac.ingest(loud());
    expect(sendFrame).not.toHaveBeenCalled();
    expect(sendVad).not.toHaveBeenCalled();
    expect(ac.streaming).toBe(false);
  });

  it("после activate() кадры стримятся; одиночный кадр НЕ будит, устойчивая речь → speech_start", () => {
    const { ac, sendFrame, sendVad, onMicState } = setup();
    ac.activate();
    expect(onMicState).toHaveBeenCalledWith(true);
    // Кадры уходят на сервер всегда (гейт открыт), но VAD дебаунсит онсет: один кадр — не речь.
    ac.ingest(loud());
    expect(sendFrame).toHaveBeenCalledTimes(1);
    expect(sendVad).not.toHaveBeenCalledWith("speech_start");
    // Устойчивая речь (onsetFrames подряд) → speech_start.
    ac.ingest(loud());
    ac.ingest(loud());
    expect(sendVad).toHaveBeenCalledWith("speech_start");
  });

  it("barge-in: УСТОЙЧИВАЯ речь во время speaking (после эхо-окна) → onBargeIn + audio.vad barge_in (§10)", () => {
    const { ac, sendVad, onBargeIn, advance } = setup();
    ac.activate();
    ac.setServerState("speaking");
    advance(400); // мимо anti-echo окна (350мс) — это настоящее перебивание
    bargeSpeak(ac, advance); // устойчивая речь ПО ВРЕМЕНИ (≥200мс), не одиночный щелчок/спайк
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    expect(sendVad).toHaveBeenCalledWith("barge_in");
    expect(sendVad).not.toHaveBeenCalledWith("speech_start");
  });

  it("barge-in ловит УМЕРЕННЫЙ голос (rms 450) — AEC душит double-talk, порог снижен (деф 250) (§10)", () => {
    const { ac, sendVad, onBargeIn, advance } = setup();
    ac.activate();
    ac.setServerState("speaking");
    advance(400); // мимо эхо-окна
    bargeSpeak(ac, advance, moderate); // приглушённый голос поверх TTS, устойчиво по времени
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    expect(sendVad).toHaveBeenCalledWith("barge_in");
  });

  it("§10 АДАПТИВНЫЙ barge: шумный ФОН (игра из колонок) поднимает порог — фон НЕ рвёт озвучку («2 слова»)", () => {
    const { ac, sendVad, onBargeIn, advance } = setup();
    ac.activate();
    // Комната шумит ~rms 900 (звук игры) ЗАДОЛГО до речи Джарвиса — EMA фона успевает подняться.
    const noise = (): Int16Array => new Int16Array(160).fill(900);
    for (let i = 0; i < 120; i += 1) ac.ingest(noise());
    ac.setServerState("speaking");
    advance(400); // мимо эхо-окна
    // Тот же фоновый уровень во время речи Джарвиса: > фикс-порога 250, но НЕ > фона×2.5 → не barge.
    for (let i = 0; i < 6; i += 1) ac.ingest(noise());
    expect(onBargeIn).not.toHaveBeenCalled();
    expect(sendVad).not.toHaveBeenCalledWith("barge_in");
    // А РЕАЛЬНЫЙ голос ПОВЕРХ фона (rms 6000 >> 900×2.5) — перебивает (устойчиво по времени).
    bargeSpeak(ac, advance);
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    expect(sendVad).toHaveBeenCalledWith("barge_in");
  });

  it("(fix 2026-07-15) КОРОТКИЙ спайк (< sustain) НЕ рвёт длинную фразу — barge только на устойчивой речи", () => {
    const { ac, sendVad, onBargeIn, advance } = setup();
    ac.activate();
    ac.setServerState("speaking");
    advance(400); // мимо эхо-окна
    // Спайк выше порога на ~80мс (< 200мс sustain: эхо TTS / стук / пик реплики по ТВ), затем провал → сброс.
    const quiet = (): Int16Array => new Int16Array(160).fill(10);
    ac.ingest(loud()); advance(40);
    ac.ingest(loud()); advance(40); // накоплено ~80мс < 200 → НЕ barge (на старом коде 2 кадра уже рвали)
    ac.ingest(quiet()); advance(300); // провал ниже порога сбрасывает отсчёт
    ac.ingest(quiet());
    expect(onBargeIn).not.toHaveBeenCalled();
    expect(sendVad).not.toHaveBeenCalledWith("barge_in");
  });

  it("(fix 2026-07-15) провал НИЖЕ толерантности (80мс < 120) НЕ рвёт отсчёт → устойчивая речь перебивает", () => {
    const { ac, sendVad, onBargeIn, advance } = setup();
    ac.activate();
    ac.setServerState("speaking");
    advance(400); // мимо эхо-окна
    const quiet = (): Int16Array => new Int16Array(160).fill(10);
    // voicedSince=t0; затем РЕАЛЬНЫЙ провал 80мс (ДВА quiet-кадра, below-интервал накапливается) < 120 → терпим.
    ac.ingest(loud()); advance(150); // voicedSince = t0
    ac.ingest(quiet()); advance(80); // below с t0+150
    ac.ingest(quiet()); // now-below = 80мс < 120 → НЕ сброс; voiced-delta = 230 ≥ 200 → barge несмотря на дыру
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    expect(sendVad).toHaveBeenCalledWith("barge_in");
  });

  it("(fix 2026-07-15) провал ВЫШЕ толерантности (200мс > 120) СБРАСЫВАЕТ отсчёт — транзиенты не склеиваются в barge", () => {
    const { ac, sendVad, onBargeIn, advance } = setup();
    ac.activate();
    ac.setServerState("speaking");
    advance(400); // мимо эхо-окна
    const quiet = (): Int16Array => new Int16Array(160).fill(10);
    ac.ingest(loud()); advance(80); // voicedSince=t0, но < 200 (barge ещё не выстрелил)
    ac.ingest(quiet()); advance(200); // below с t0+80
    ac.ingest(quiet()); // now-below = 200мс > 120 → СБРОС voicedSince=0 (провал = конец фрагмента)
    advance(50);
    ac.ingest(loud()); // отсчёт свежий (не склеен со старым) → 200мс ещё не набрано → НЕ barge
    expect(onBargeIn).not.toHaveBeenCalled();
    expect(sendVad).not.toHaveBeenCalledWith("barge_in");
  });

  it("(ревью #close) стейл-отсчёт НЕ переживает закрытие окна: короткий голос → listening → реоткрытие → транзиент НЕ рвёт", () => {
    const { ac, sendVad, onBargeIn, advance } = setup();
    ac.activate();
    ac.setServerState("speaking");
    advance(400); // мимо эхо-окна
    // Владелец коротко сказал (< sustain 200мс, barge НЕ сработал) — но bargeVoicedSince набран.
    ac.ingest(loud()); advance(60);
    ac.ingest(loud());
    expect(onBargeIn).not.toHaveBeenCalled();
    // Окно закрывается (сервер ушёл в listening, звук доиграл) — стейл-отсчёт ДОЛЖЕН обнулиться.
    ac.setServerState("listening");
    ac.setPlaybackActive(false);
    advance(500);
    ac.setPlaybackActive(true); // следующая фраза реоткрывает окно (хвост плеера)
    advance(400);
    // Одиночный транзиент: на СТАРОМ коде стейл-отсчёт (now-since >= 200) выстрелил бы barge; на фиксе — нет.
    ac.ingest(loud());
    expect(onBargeIn).not.toHaveBeenCalled();
    expect(sendVad).not.toHaveBeenCalledWith("barge_in");
  });

  it("barge В ХВОСТЕ: сервер уже не speaking, но звук ЕЩЁ играет (playbackActive) → перебить можно (§10)", () => {
    // Корень жалобы «не могу перебить»: синтез кончается РАНЬШЕ плеера, сервер уходит из speaking, и
    // раньше barge в этом окне был выключен. Теперь playbackActive держит окно, пока звук реально идёт.
    const { ac, sendVad, onBargeIn, advance } = setup();
    ac.activate();
    ac.setServerState("speaking");
    ac.setServerState("listening"); // синтез завершился, сервер ушёл из speaking…
    ac.setPlaybackActive(true); // …но плеер ещё доигрывает хвост очереди
    advance(400);
    bargeSpeak(ac, advance); // юзер реагирует на сказанное — устойчиво по времени
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    expect(sendVad).toHaveBeenCalledWith("barge_in");
  });

  it("звук доиграл (playbackActive=false) → ОБЫЧНАЯ прослушка, НЕ barge (слух не сломан)", () => {
    const { ac, sendVad, onBargeIn } = setup();
    ac.activate();
    ac.setServerState("speaking");
    ac.setServerState("listening");
    ac.setPlaybackActive(true);
    ac.setPlaybackActive(false); // очередь опустела — звук кончился
    speak(ac); // речь юзера → обычный speech_start, НЕ перебивание
    expect(onBargeIn).not.toHaveBeenCalled();
    expect(sendVad).toHaveBeenCalledWith("speech_start");
  });

  it("anti-echo grace: речь в первые мс TTS НЕ считается barge-in (§10)", () => {
    const { ac, sendVad, onBargeIn } = setup();
    ac.activate();
    ac.setServerState("speaking");
    // Время не двигаем (0 < 350мс) — это эхо-хвост собственного TTS, не перебивание.
    speak(ac);
    expect(onBargeIn).not.toHaveBeenCalled();
    expect(sendVad).not.toHaveBeenCalledWith("barge_in");
  });

  it("ambient: возврат сервера в idle НЕ закрывает гейт (§3, слушаем дальше)", () => {
    // После активации Джарвис слушает постоянно (wake word — заглушка, переоткрыть
    // гейт некому). Закрытие на idle делало его «глухим» после первой реплики.
    const { ac, sendFrame } = setup();
    ac.activate();
    ac.setServerState("idle");
    expect(ac.streaming).toBe(true);
    ac.ingest(loud());
    expect(sendFrame).toHaveBeenCalledTimes(1);
  });

  it("mute() — честный privacy-стоп: гейт закрыт, аудио на сервер не уходит (§0.6)", () => {
    const { ac, sendFrame, onMicState } = setup();
    ac.activate();
    ac.mute();
    expect(onMicState).toHaveBeenLastCalledWith(false);
    expect(ac.streaming).toBe(false);
    ac.ingest(loud());
    expect(sendFrame).not.toHaveBeenCalled();
  });

  it("реальный wake word открывает гейт по детекту", () => {
    let fired = false;
    const wakeword: IWakeWord = {
      ready: true,
      process: () => {
        if (!fired) {
          fired = true;
          return true;
        }
        return false;
      },
    };
    const { ac, sendFrame } = setup(wakeword);
    ac.ingest(loud()); // первый кадр → детект → гейт открыт → кадр уходит
    expect(ac.streaming).toBe(true);
    expect(sendFrame).toHaveBeenCalledTimes(1);
  });
});

describe("W1 (2026-09-09): локальный wake — гейт закрыт между ходами, пре-ролл, честный mute", () => {
  /** Wake-детектор, который срабатывает на N-м кадре. */
  function wakeOnFrame(n: number): IWakeWord & { calls: number } {
    const w = {
      ready: true,
      calls: 0,
      process: (_p: Int16Array) => {
        w.calls += 1;
        return w.calls === n;
      },
    };
    return w;
  }

  it("до wake кадры в облако НЕ уходят; на wake: audio.vad wake_local + пре-ролл (включая кадры ДО слова) + живой поток", () => {
    const wake = wakeOnFrame(3);
    const { ac, sendFrame, sendVad, onMicState } = setup(wake);
    ac.ingest(loud());
    ac.ingest(loud());
    expect(sendFrame).not.toHaveBeenCalled();
    ac.ingest(loud()); // 3-й кадр — детект
    expect(sendVad).toHaveBeenCalledWith("wake_local");
    expect(sendFrame).toHaveBeenCalledTimes(3); // пре-ролл: все три кадра, в т.ч. два ДО срабатывания
    expect(onMicState).toHaveBeenLastCalledWith(true);
    ac.ingest(loud());
    expect(sendFrame).toHaveBeenCalledTimes(4); // дальше — живой поток
  });

  it("idle сервера ЗАКРЫВАЕТ гейт, когда есть локальный wake (§0.6 по построению); без него — нет (прежнее поведение)", () => {
    const local = setup(wakeOnFrame(1));
    local.ac.activate(); // с локальным wake activate() гейт НЕ открывает (слух = детектор на устройстве)
    local.ac.ingest(loud()); // 1-й кадр — детект → гейт открыт, пре-ролл ушёл
    expect(local.sendFrame).toHaveBeenCalledTimes(1);
    local.ac.setServerState("idle"); // ход кончился → гейт закрывается
    local.ac.ingest(loud());
    expect(local.sendFrame).toHaveBeenCalledTimes(1); // гейт закрыт — только локальный детектор
    expect(local.onMicState).toHaveBeenLastCalledWith(false);

    const cloud = setup(); // MockWakeWord (ready=false)
    cloud.ac.activate();
    cloud.ac.setServerState("idle");
    cloud.ac.ingest(loud());
    expect(cloud.sendFrame).toHaveBeenCalledTimes(1); // как раньше: слушает постоянно
  });

  it("mute: кадры не доходят даже до локального детектора; activate снимает mute", () => {
    const wake = wakeOnFrame(1);
    const { ac, sendFrame } = setup(wake);
    ac.mute();
    ac.ingest(loud());
    expect(wake.calls).toBe(0);
    expect(sendFrame).not.toHaveBeenCalled();
    ac.activate();
    ac.ingest(loud());
    expect(sendFrame).toHaveBeenCalledTimes(1);
  });

  it("activate({hold}) держит гейт на idle (запись голоса); release() закрывает", () => {
    const { ac, sendFrame } = setup(wakeOnFrame(999));
    ac.activate({ hold: true });
    ac.setServerState("idle");
    ac.ingest(loud());
    expect(sendFrame).toHaveBeenCalledTimes(1); // удержание — гейт открыт
    ac.release();
    ac.ingest(loud());
    expect(sendFrame).toHaveBeenCalledTimes(1); // закрылся
  });

  it("setEngines: локальный wake появился при простое сервера → открытый гейт закрывается", () => {
    const { ac, sendFrame } = setup();
    ac.activate();
    ac.ingest(loud());
    expect(sendFrame).toHaveBeenCalledTimes(1);
    ac.setEngines({ wake: wakeOnFrame(999) });
    ac.ingest(loud());
    expect(sendFrame).toHaveBeenCalledTimes(1); // больше не стримит
  });
});

describe("W1: закрытие гейта по таймеру listening (фон в комнате не даёт серверу дойти до idle)", () => {
  function wakeOnFrame(n: number): IWakeWord & { calls: number } {
    const w = {
      ready: true,
      calls: 0,
      process: (_p: Int16Array) => {
        w.calls += 1;
        return w.calls === n;
      },
    };
    return w;
  }
  /** Кадры каждые 100 мс «живого» времени в течение ms (fake timers двигаются вместе с кадрами). */
  function feed(ac: AudioCoordinator, ms: number): void {
    for (let t = 0; t < ms; t += 100) {
      ac.ingest(loud());
      vi.advanceTimersByTime(100);
    }
  }

  it("сервер завис в listening, а РЕЧИ нет (шорохи) → через 10 с гейт закрывается; новый ход (thinking) отменяет таймер", () => {
    // Ревью 2026-09-24 (B-F3): прежняя версия этого теста называлась «ТВ держит VAD» и закрепляла закрытие
    // «несмотря на громкие кадры». Одиночные громкие кадры до онсета VAD не доходят (speaking=false), поэтому
    // тест и тогда проверял «шорохи», а не речь. Теперь речь явно ДЕРЖИТ гейт (кейсы ниже), а шорохи — нет.
    vi.useFakeTimers();
    try {
      const { ac, sendFrame } = setup(wakeOnFrame(1));
      ac.ingest(loud()); // wake → гейт открыт
      expect(sendFrame).toHaveBeenCalledTimes(1);
      ac.setServerState("listening");
      vi.advanceTimersByTime(9_000);
      ac.ingest(loud());
      expect(sendFrame).toHaveBeenCalledTimes(2); // ещё открыт
      vi.advanceTimersByTime(1_500);
      ac.ingest(loud());
      expect(sendFrame).toHaveBeenCalledTimes(2); // закрылся по таймеру

      // Второй сценарий: listening → thinking (ход пошёл) → таймер снят, гейт живёт.
      const b = setup(wakeOnFrame(1));
      b.ac.ingest(loud());
      b.ac.setServerState("listening");
      vi.advanceTimersByTime(8_000);
      b.ac.setServerState("thinking");
      vi.advanceTimersByTime(5_000);
      b.ac.ingest(loud());
      expect(b.sendFrame).toHaveBeenCalledTimes(2); // открыт: ход в работе
    } finally {
      vi.useRealTimers();
    }
  });

  it("B-F3: владелец заговорил на 9-й секунде — гейт НЕ закрывается посреди фразы, а через 10 с после её конца", () => {
    vi.useFakeTimers();
    try {
      const vad = new ScriptVad();
      const { ac, sendFrame, sendVad } = setup(wakeOnFrame(1), { vad });
      ac.ingest(loud()); // wake → гейт открыт
      ac.setServerState("listening");
      vi.advanceTimersByTime(9_000);
      vad.say(); // речь пошла
      feed(ac, 6_000); // говорит до 15-й секунды (старый код закрыл бы гейт на 10-й)
      expect(ac.streaming).toBe(true);
      vad.hush();
      ac.ingest(loud()); // кадр с speech_end
      expect(sendVad).toHaveBeenCalledWith("speech_end");
      vi.advanceTimersByTime(9_500);
      expect(ac.streaming).toBe(true); // тишина 9,5 с < 10 с — ждём follow-up
      vi.advanceTimersByTime(1_000);
      expect(ac.streaming).toBe(false); // 10 с тишины после конца речи → закрыт
      const sent = sendFrame.mock.calls.length;
      ac.ingest(loud());
      expect(sendFrame.mock.calls.length).toBe(sent);
    } finally {
      vi.useRealTimers();
    }
  });

  it("B-F3: речь без конца (ТВ) держит гейт не дольше потолка 30 с; закрытие посреди речи досылает серверу speech_end", () => {
    vi.useFakeTimers();
    try {
      const vad = new ScriptVad();
      const { ac, sendVad } = setup(wakeOnFrame(1), { vad });
      ac.ingest(loud());
      ac.setServerState("listening");
      vad.say();
      feed(ac, 29_000);
      expect(ac.streaming).toBe(true); // речь сдвигает дедлайн тишины
      expect(sendVad).not.toHaveBeenCalledWith("speech_end");
      feed(ac, 1_500);
      expect(ac.streaming).toBe(false); // потолок: фон не держит гейт вечно
      // userSpeaking на сервере не залипает: speech_start ушёл → конец речи досылается при закрытии.
      expect(sendVad).toHaveBeenCalledWith("speech_end");
      expect(vad.reset).toHaveBeenCalled(); // VAD сброшен — новая реплика снова даст speech_start
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("B-F3: закрытие гейта посреди речи (любой путь) досылает speech_end", () => {
  it("mute() посреди фразы → speech_end; после реоткрытия новая реплика снова даёт speech_start", () => {
    const vad = new ScriptVad();
    const { ac, sendVad } = setup(undefined, { vad });
    ac.activate();
    vad.say();
    ac.ingest(loud());
    expect(sendVad).toHaveBeenCalledWith("speech_start");
    ac.mute();
    expect(sendVad).toHaveBeenLastCalledWith("speech_end");
    expect(vad.speaking).toBe(false); // сброшен при закрытии
    ac.activate();
    vad.say();
    ac.ingest(loud());
    expect(sendVad.mock.calls.filter((c) => c[0] === "speech_start")).toHaveLength(2);
  });

  it("закрытие без открытой речи speech_end НЕ шлёт (сервер не получает конец того, что не начиналось)", () => {
    const { ac, sendVad } = setup();
    ac.activate();
    ac.mute();
    expect(sendVad).not.toHaveBeenCalledWith("speech_end");
  });
});

describe("B-F12: пре-ролл 0,9 с (45 кадров × 20 мс), а не 1,5 с", () => {
  it("wake на 51-м кадре → в облако уходят только 45 последних кадров до срабатывания", () => {
    let n = 0;
    const wake: IWakeWord = { ready: true, process: () => ++n === 51 };
    const { ac, sendFrame } = setup(wake);
    for (let i = 0; i < 51; i += 1) ac.ingest(new Int16Array(320).fill(10));
    expect(sendFrame).toHaveBeenCalledTimes(45);
  });
});

describe("B-F8: push-to-talk и видимость промаха wake", () => {
  const never = (): IWakeWord => ({ ready: true, process: () => false });

  it("pushToTalk при локальном wake: гейт открыт, серверу wake_local, без речи закрывается через 8 с", () => {
    vi.useFakeTimers();
    try {
      const { ac, sendVad, sendFrame } = setup(never());
      expect(ac.pushToTalk("hotkey")).toBe(true);
      expect(ac.streaming).toBe(true);
      expect(sendVad).toHaveBeenCalledWith("wake_local");
      ac.ingest(loud());
      expect(sendFrame).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(8_100);
      expect(ac.streaming).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("activate({ptt}) — кнопка открывает гейт; обычный activate() при локальном wake — нет (стартовая синхронизация)", () => {
    const a = setup(never());
    a.ac.activate();
    expect(a.ac.streaming).toBe(false);
    expect(a.sendVad).not.toHaveBeenCalledWith("wake_local");
    const b = setup(never());
    b.ac.activate({ ptt: true });
    expect(b.ac.streaming).toBe(true);
    expect(b.sendVad).toHaveBeenCalledWith("wake_local");
  });

  it("mute главнее PTT: хоткей при выключенном микрофоне гейт не открывает", () => {
    const { ac, sendVad } = setup(never());
    ac.mute();
    expect(ac.pushToTalk("hotkey")).toBe(false);
    expect(ac.streaming).toBe(false);
    expect(sendVad).not.toHaveBeenCalledWith("wake_local");
  });

  it("речь при закрытом гейте без срабатывания wake → один лог «кандидат в промах» (не чаще раза в минуту)", () => {
    const log = spyLog();
    const { ac } = setup(never(), { log });
    const utter = (): void => {
      for (let i = 0; i < 40; i += 1) ac.ingest(new Int16Array(320).fill(6000)); // 0,8 с речи (кадр 20 мс)
      for (let i = 0; i < 20; i += 1) ac.ingest(new Int16Array(320).fill(10)); // тишина → конец отрезка
    };
    utter();
    utter();
    const misses = log.info.mock.calls.filter((c) => String(c[0]).includes("промах KWS"));
    expect(misses).toHaveLength(1); // второй отрезок — в том же окне троттла
    expect(misses[0]![1]).toMatchObject({ segments: 1, kwsScore: "sherpa не отдаёт" });
  });

  it("сплошной фон (> 4 с) промахом не считается", () => {
    const log = spyLog();
    const { ac } = setup(never(), { log });
    for (let i = 0; i < 300; i += 1) ac.ingest(new Int16Array(320).fill(6000)); // 6 с
    for (let i = 0; i < 20; i += 1) ac.ingest(new Int16Array(320).fill(10));
    expect(log.info.mock.calls.filter((c) => String(c[0]).includes("промах KWS"))).toHaveLength(0);
  });
});

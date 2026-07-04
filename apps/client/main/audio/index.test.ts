import { describe, expect, it, vi } from "vitest";
import type { IWakeWord } from "../wakeword/index.js";
import { AudioCoordinator } from "./index.js";

const loud = (): Int16Array => new Int16Array(160).fill(6000);
/** Умеренный уровень (rms 450): ниже старого порога barge 600, выше нового 350 — должен перебивать. */
const moderate = (): Int16Array => new Int16Array(160).fill(450);
/** Прогнать onsetFrames громких кадров — устойчивая речь, чтобы VAD дал speech_start (анти-дребезг). */
const speak = (ac: { ingest(p: Int16Array): void }, frames = 3): void => {
  for (let i = 0; i < frames; i += 1) ac.ingest(loud());
};

function setup(wakeword?: IWakeWord) {
  const sendFrame = vi.fn();
  const sendVad = vi.fn();
  const onMicState = vi.fn();
  const onBargeIn = vi.fn();
  let clock = 0;
  const advance = (ms: number): void => {
    clock += ms;
  };
  const ac = new AudioCoordinator({ sendFrame, sendVad, onMicState, onBargeIn, wakeword, now: () => clock });
  return { ac, sendFrame, sendVad, onMicState, onBargeIn, advance };
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
    speak(ac); // онсет-дебаунс: barge_in на устойчивой речи, не на одиночном щелчке
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    expect(sendVad).toHaveBeenCalledWith("barge_in");
    expect(sendVad).not.toHaveBeenCalledWith("speech_start");
  });

  it("barge-in ловит УМЕРЕННЫЙ голос (rms 450) — AEC душит double-talk, порог снижен (деф 250) (§10)", () => {
    const { ac, sendVad, onBargeIn, advance } = setup();
    ac.activate();
    ac.setServerState("speaking");
    advance(400); // мимо эхо-окна
    for (let i = 0; i < 3; i += 1) ac.ingest(moderate()); // приглушённый голос поверх TTS
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
    // А РЕАЛЬНЫЙ голос ПОВЕРХ фона (rms 6000 >> 900×2.5) — перебивает как раньше.
    for (let i = 0; i < 3; i += 1) ac.ingest(loud());
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    expect(sendVad).toHaveBeenCalledWith("barge_in");
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
    speak(ac); // юзер реагирует на сказанное
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

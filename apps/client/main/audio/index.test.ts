import { describe, expect, it, vi } from "vitest";
import type { IWakeWord } from "../wakeword/index.js";
import { AudioCoordinator } from "./index.js";

const loud = (): Int16Array => new Int16Array(160).fill(6000);

function setup(wakeword?: IWakeWord) {
  const sendFrame = vi.fn();
  const sendVad = vi.fn();
  const onMicState = vi.fn();
  const onBargeIn = vi.fn();
  const ac = new AudioCoordinator({ sendFrame, sendVad, onMicState, onBargeIn, wakeword });
  return { ac, sendFrame, sendVad, onMicState, onBargeIn };
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

  it("после activate() кадры стримятся и эмитится speech_start", () => {
    const { ac, sendFrame, sendVad, onMicState } = setup();
    ac.activate();
    expect(onMicState).toHaveBeenCalledWith(true);
    ac.ingest(loud());
    expect(sendFrame).toHaveBeenCalledTimes(1);
    expect(sendVad).toHaveBeenCalledWith("speech_start");
  });

  it("barge-in: речь во время speaking → onBargeIn + audio.vad barge_in (§10)", () => {
    const { ac, sendVad, onBargeIn } = setup();
    ac.activate();
    ac.setServerState("speaking");
    ac.ingest(loud());
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    expect(sendVad).toHaveBeenCalledWith("barge_in");
    expect(sendVad).not.toHaveBeenCalledWith("speech_start");
  });

  it("возврат сервера в idle закрывает гейт", () => {
    const { ac, sendFrame, onMicState } = setup();
    ac.activate();
    ac.setServerState("idle");
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

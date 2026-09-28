/**
 * Подстраховка слова «Джарвис» на клиенте (28.09): громкий короткий отрезок речи при ЗАКРЫТОМ гейте, на котором
 * локальный детектор промолчал, уходит серверу одним сообщением; тихое, слишком короткое/длинное, поймано во время
 * или сразу после речи Джарвиса, при mute или не в покое — не уходит. Вердикт accepted открывает гейт.
 */
import type { Logger } from "@jarvis/shared";
import { describe, expect, it, vi } from "vitest";
import type { IWakeWord } from "../wakeword/index.js";
import { AudioCoordinator } from "./index.js";
import { SegmentRecorder } from "./segment-recorder.js";

const frame = (v: number): Int16Array => new Int16Array(320).fill(v); // 20 мс при 16 кГц
const LOUD = 10_000; // пик rms промахов 28.09 был 10–16K
const never: IWakeWord = { ready: true, process: () => false };

function setup(opts: { sendRescue?: boolean } = {}) {
  const sendRescue = vi.fn((_pcm: Int16Array, _m: { ms: number; peak: number }) => true);
  const sendFrame = vi.fn();
  const sendVad = vi.fn();
  const onMicState = vi.fn();
  let clock = 1_000_000;
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as unknown as Logger;
  const ac = new AudioCoordinator({
    sendFrame,
    sendVad,
    onMicState,
    ...(opts.sendRescue === false ? {} : { sendRescue }),
    wakeword: never,
    now: () => clock,
    log,
  });
  const advance = (ms: number): void => {
    clock += ms;
  };
  /** Отрезок речи: n громких кадров + тишина до конца отрезка VAD (hangover 12 кадров). */
  const utter = (frames: number, level = LOUD): void => {
    for (let i = 0; i < frames; i += 1) ac.ingest(frame(level));
    for (let i = 0; i < 30; i += 1) ac.ingest(frame(10)); // > hangover WakeMissMonitor (25 кадров = 500 мс)
  };
  return { ac, sendRescue, sendFrame, sendVad, onMicState, advance, utter };
}

describe("отбор отрезков для подстраховки", () => {
  it("громкая реплика ~1 с при закрытом гейте → ОДИН отрезок: pcm с пре-роллом и телом, ms/peak в мета", () => {
    const { utter, sendRescue, sendFrame } = setup();
    utter(50);
    expect(sendRescue).toHaveBeenCalledTimes(1);
    const [pcm, meta] = sendRescue.mock.calls[0]!;
    expect(meta.ms).toBeGreaterThanOrEqual(700);
    expect(meta.peak).toBeGreaterThanOrEqual(6_000);
    expect(pcm.length).toBeGreaterThanOrEqual(50 * 320); // само тело (+ пре-ролл до онсета)
    expect(pcm.length).toBeLessThanOrEqual((50 + 12 + 25) * 320); // + hangover + пре-ролл, не весь поток
    expect(Math.max(...pcm)).toBe(LOUD); // это реальный звук, а не нули
    expect(sendFrame).not.toHaveBeenCalled(); // стрим по-прежнему закрыт — уходит только отрезок
  });

  it("B4: «Джарвис» — пауза 0,3 с — команда = ОДИН отрезок, а не два (голое «Джарвис» отдельно и потерянная команда)", () => {
    const { ac, sendRescue } = setup();
    for (let i = 0; i < 30; i += 1) ac.ingest(frame(LOUD)); // «Джарвис» 0,6 с
    for (let i = 0; i < 15; i += 1) ac.ingest(frame(10)); // пауза 0,3 с
    for (let i = 0; i < 40; i += 1) ac.ingest(frame(LOUD)); // «включи музыку» 0,8 с
    for (let i = 0; i < 30; i += 1) ac.ingest(frame(10));
    expect(sendRescue).toHaveBeenCalledTimes(1);
    expect(sendRescue.mock.calls[0]![1].ms).toBeGreaterThan(1_400);
  });

  it("раунд 2 (#9): хлопок/кашель 0,3 с (+хвост VAD 0,5 с) кандидатом не считается; реальная речь 0,6 с — считается", () => {
    const a = setup();
    a.utter(15); // 300 мс громко
    expect(a.sendRescue).not.toHaveBeenCalled();
    const b = setup();
    b.utter(30); // 600 мс
    expect(b.sendRescue).toHaveBeenCalledTimes(1);
  });

  it("раунд 2 (LOW): реконнект (syncServerIdle) обновляет состояние сервера, но НЕ закрывает гейт кнопки микрофона", () => {
    const { ac, sendRescue, utter } = setup();
    ac.setServerState("thinking");
    ac.syncServerIdle();
    utter(50);
    expect(sendRescue).toHaveBeenCalledTimes(1); // состояние стало idle
    const p = setup();
    p.ac.pushToTalk("button", { address: false });
    p.ac.syncServerIdle();
    expect(p.ac.streaming).toBe(true);
  });

  it.each([
    ["тихая речь (пик 3000)", 50, 3_000],
    ["слишком короткая (0,3 с)", 8, LOUD],
    ["сплошной фон дольше 4 с", 300, LOUD],
  ])("%s → не уходит", (_n, frames, level) => {
    const { utter, sendRescue } = setup();
    utter(frames, level);
    expect(sendRescue).not.toHaveBeenCalled();
  });

  it("Джарвис говорит (сервер speaking / динамик играет) → отрезок не уходит; сразу после конца звука (эхо-хвост) — тоже; позже — уходит", () => {
    const { ac, utter, sendRescue, advance } = setup();
    ac.setServerState("speaking");
    utter(50);
    expect(sendRescue).not.toHaveBeenCalled();
    ac.setServerState("idle");
    ac.setPlaybackActive(true);
    utter(50);
    expect(sendRescue).not.toHaveBeenCalled();
    ac.setPlaybackActive(false);
    advance(500); // эхо-хвост
    utter(50);
    expect(sendRescue).not.toHaveBeenCalled();
    advance(2_000);
    utter(50);
    expect(sendRescue).toHaveBeenCalledTimes(1);
  });

  it("сервер не в покое (идёт ход) → не уходит", () => {
    const { ac, utter, sendRescue } = setup();
    ac.setServerState("thinking");
    utter(50);
    expect(sendRescue).not.toHaveBeenCalled();
  });

  it("честный mute → ни отрезка, ни записи", () => {
    const { ac, utter, sendRescue } = setup();
    ac.mute();
    utter(50);
    expect(sendRescue).not.toHaveBeenCalled();
  });

  it("B1: mute ПОСРЕДИ фразы при закрытом гейте → после unmute «до-mute» звук в облако не уходит и не склеивается с новой речью", () => {
    const { ac, sendRescue, advance } = setup();
    for (let i = 0; i < 40; i += 1) ac.ingest(frame(LOUD)); // громкая речь, mute не дожидаясь конца
    ac.mute();
    advance(3_600_000);
    ac.activate(); // владелец снял mute и молчит
    for (let i = 0; i < 30; i += 1) ac.ingest(frame(10));
    expect(sendRescue).not.toHaveBeenCalled();
  });

  it("B1: mute сразу после отправки фрагмента → серверу speech_cancel (разбор в облаке не должен запустить ход)", () => {
    const { ac, utter, sendRescue, sendVad } = setup();
    utter(50);
    expect(sendRescue).toHaveBeenCalledTimes(1);
    ac.mute();
    expect(sendVad).toHaveBeenCalledWith("speech_cancel");
  });

  it("mute спустя долгое время после отправки — speech_cancel не шлётся (фрагмент давно разобран)", () => {
    const { ac, utter, sendVad, advance } = setup();
    utter(50);
    advance(30_000);
    ac.mute();
    expect(sendVad).not.toHaveBeenCalledWith("speech_cancel");
  });

  it("гейт открыт (обычный wake сработал) → подстраховка не нужна, отрезок не режется", () => {
    const { ac, utter, sendRescue } = setup();
    ac.pushToTalk("hotkey");
    utter(50);
    expect(sendRescue).not.toHaveBeenCalled();
  });

  it("сокет закрыт (sendRescue → false) — не падаем", () => {
    const { utter, sendRescue } = setup();
    sendRescue.mockReturnValue(false);
    expect(() => utter(50)).not.toThrow();
    expect(sendRescue).toHaveBeenCalledTimes(1);
  });

  it("без sendRescue (заглушки, тесты) поведение прежнее: ничего не пишется и не шлётся", () => {
    const { utter, sendFrame } = setup({ sendRescue: false });
    expect(() => utter(50)).not.toThrow();
    expect(sendFrame).not.toHaveBeenCalled();
  });
});

describe("вердикт сервера", () => {
  it("accepted → гейт открывается под продолжение (кадры пошли), как после обычного «Джарвис»", () => {
    const { ac, onMicState, sendFrame } = setup();
    expect(ac.streaming).toBe(false);
    ac.onWakeRescued();
    expect(ac.streaming).toBe(true);
    expect(onMicState).toHaveBeenLastCalledWith(true);
    ac.ingest(frame(LOUD));
    expect(sendFrame).toHaveBeenCalledTimes(1);
  });

  it("bare («Джарвис» без команды): пре-ролл проигрывается в открывшийся поток — там начало команды; НЕ bare — пре-ролл не повторяется (дубль)", () => {
    const a = setup();
    for (let i = 0; i < 10; i += 1) a.ac.ingest(frame(LOUD)); // копится пре-ролл закрытого гейта
    a.ac.onWakeRescued(true);
    expect(a.sendFrame).toHaveBeenCalledTimes(10);
    const b = setup();
    for (let i = 0; i < 10; i += 1) b.ac.ingest(frame(LOUD));
    b.ac.onWakeRescued(false);
    expect(b.ac.streaming).toBe(true);
    expect(b.sendFrame).not.toHaveBeenCalled();
  });

  it("при mute вердикт гейт НЕ открывает: красная кнопка не врёт", () => {
    const { ac } = setup();
    ac.mute();
    ac.onWakeRescued();
    expect(ac.streaming).toBe(false);
  });
});

describe("SegmentRecorder", () => {
  const start = (r: SegmentRecorder, n: number): void => {
    for (let i = 0; i < n; i += 1) r.push(frame(100 + i), i === n - 1 ? "speech_start" : null, i === n - 1);
  };

  it("пре-ролл входит в отрезок, take() отдаёт всё одним буфером и забывает его", () => {
    const r = new SegmentRecorder(5, 50);
    start(r, 8); // в кольце последние 5 кадров
    r.push(frame(7), null, true);
    r.push(frame(8), "speech_end", false);
    const out = r.take()!;
    expect(out.length).toBe((5 + 2) * 320);
    expect(out[0]).toBe(100 + 3); // самый старый кадр кольца — 4-й из 8
    expect(r.take()).toBeNull();
  });

  it("длиннее потолка → отрезок брошен (фон), память не растёт", () => {
    const r = new SegmentRecorder(2, 10);
    start(r, 3);
    for (let i = 0; i < 20; i += 1) r.push(frame(1), null, true);
    expect(r.take()).toBeNull();
  });
});

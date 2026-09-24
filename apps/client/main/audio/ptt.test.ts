/**
 * Ревью 2026-09-24 (B-F8): push-to-talk — проводка через НАСТОЯЩИЙ AudioCoordinator.
 * Кнопка микрофона (IPC activate после mute) и Ctrl+Alt+J открывают гейт и дают серверу окно адресации;
 * стартовая синхронизация renderer (activate без предшествующего mute) — НЕ открывает (W1-регрессия).
 */
import { describe, expect, it, vi } from "vitest";
import type { IWakeWord } from "../wakeword/index.js";
import { AudioCoordinator } from "./index.js";
import { MicControl } from "./mic-control.js";
import { PTT_HOTKEY, registerPttHotkey } from "./ptt-hotkey.js";

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => silentLog };
const localWake = (): IWakeWord => ({ ready: true, process: () => false });

function rig() {
  const sendVad = vi.fn();
  const sendFrame = vi.fn();
  const audio = new AudioCoordinator({ sendFrame, sendVad, wakeword: localWake(), log: silentLog });
  const mic = new MicControl(() => audio);
  const wakeLocals = (): number => sendVad.mock.calls.filter((c) => c[0] === "wake_local").length;
  return { audio, mic, sendVad, sendFrame, wakeLocals };
}

describe("MicControl + AudioCoordinator: кнопка микрофона = push-to-talk, старт — нет", () => {
  it("стартовая синхронизация (activate без mute) гейт НЕ открывает и адресацию серверу не шлёт", () => {
    const { audio, mic, wakeLocals } = rig();
    expect(mic.activate()).toBe(false);
    expect(audio.streaming).toBe(false);
    expect(wakeLocals()).toBe(0);
  });

  // Контроль-1 №9 (ревью 2026-09-24): кнопка открывает микрофон, но НЕ окно адресации — иначе реплика ТВ в первые
  // 8 с после включения уходила командой (да ещё «явным обращением» с правом на слепой реплей). Обращение — «Джарвис»;
  // окно адресации без слова — только у хоткея (его жмут ровно чтобы сказать).
  it("выключил → включил кнопкой: гейт открыт (облачный STT услышит «Джарвис»), окна адресации нет", () => {
    const { audio, mic, wakeLocals } = rig();
    mic.mute();
    expect(mic.killSwitchOn).toBe(true);
    expect(mic.activate()).toBe(true);
    expect(audio.streaming).toBe(true);
    expect(wakeLocals()).toBe(0);
  });

  it("включил кнопкой при мёртвом захвате, а позже onUp досылает activate — push-to-talk не повторяется", () => {
    const { mic } = rig();
    mic.mute(); // стартовая синхронизация «выключен»
    expect(mic.activate()).toBe(true); // клик «включить» (захват ещё не поднят)
    expect(mic.activate()).toBe(false); // onUp после подъёма захвата — уже не жест владельца
  });
});

describe("registerPttHotkey", () => {
  it(`${PTT_HOTKEY}: нажатие открывает гейт через pushToTalk`, () => {
    const { audio, wakeLocals } = rig();
    let pressed: (() => void) | null = null;
    const accel = registerPttHotkey({
      register: (_a, cb) => {
        pressed = cb;
        return true;
      },
      onPress: () => audio.pushToTalk("hotkey"),
      log: silentLog,
    });
    expect(accel).toBe(PTT_HOTKEY);
    pressed!();
    expect(audio.streaming).toBe(true);
    expect(wakeLocals()).toBe(1);
  });

  it("клавиша занята / регистрация бросила → null и честный WARN (не молчаливое «зарегистрировано»)", () => {
    const warn = vi.fn();
    const log = { info: vi.fn(), warn };
    expect(registerPttHotkey({ register: () => false, onPress: vi.fn(), log })).toBeNull();
    expect(
      registerPttHotkey({
        register: () => {
          throw new Error("conflict");
        },
        onPress: vi.fn(),
        log,
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

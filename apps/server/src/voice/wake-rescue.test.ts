/**
 * Подстраховка слова «Джарвис» (28.09). Часть 1 — судья WakeRescue (лимиты, приватность, гонки); часть 2 — настоящий
 * VoicePipeline: спасённая фраза становится ходом, чужая/пустая — нет, и ход в работе не перебивается.
 */
import { describe, expect, it, vi } from "vitest";
import type { ISttProvider, ITtsProvider, SttStream, TtsChunk, TtsStream } from "../integrations/voice-providers.js";
import { VoicePipeline } from "./pipeline.js";
import type { VoiceState } from "./state.js";
import { RESCUE_MAX_BYTES, RESCUE_MAX_PER_HOUR, RESCUE_MIN_BYTES, RESCUE_MIN_GAP_MS, WakeRescue } from "./wake-rescue.js";

const PCM = new ArrayBuffer(48_000); // 1,5 с при 16 кГц s16le
const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function judge(over: Partial<ConstructorParameters<typeof WakeRescue>[0]> = {}) {
  const clock = { t: 1_000_000 };
  const accept = vi.fn(() => true);
  const transcribe = vi.fn(async () => "Джарвис, ты меня слышишь?");
  const log = { ...silentLog, info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const r = new WakeRescue({ transcribe, isIdle: () => true, accept, now: () => clock.t, log: log as never, ...over });
  return { r, clock, accept, transcribe: (over.transcribe ?? transcribe) as ReturnType<typeof vi.fn>, log };
}

describe("WakeRescue: судья фрагмента", () => {
  it("обращение в тексте → accepted, ход принят с нормализованным текстом", async () => {
    const { r, accept } = judge();
    expect(await r.judge(PCM, 16_000, { ms: 1500, peak: 12_000 })).toBe("accepted");
    expect(accept).toHaveBeenCalledWith("Джарвис, ты меня слышишь?");
  });

  it("коверканое STT-обращение («Жорвит…») тоже находится — те же варианты, что у гейта wake", async () => {
    const { r, accept } = judge({ transcribe: vi.fn(async () => "Жорвит, включи музыку") });
    expect(await r.judge(PCM, 16_000)).toBe("accepted");
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("обращения нет (фон, ТВ, чужой разговор) → rejected, ход НЕ принят, текст в лог не пишется", async () => {
    const { r, accept, log } = judge({ transcribe: vi.fn(async () => "да я вчера ему то же самое сказал") });
    expect(await r.judge(PCM, 16_000, { ms: 1800, peak: 9000 })).toBe("rejected");
    expect(accept).not.toHaveBeenCalled();
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.debug.mock.calls]);
    expect(logged).not.toContain("вчера");
    expect(logged).not.toContain("сказал");
  });

  it("пустой текст (тишина/шум) → rejected", async () => {
    const { r, accept } = judge({ transcribe: vi.fn(async () => "") });
    expect(await r.judge(PCM, 16_000)).toBe("rejected");
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    ["не 16 кГц", new ArrayBuffer(48_000), 44_100],
    ["слишком короткий", new ArrayBuffer(RESCUE_MIN_BYTES - 2), 16_000],
    ["слишком длинный", new ArrayBuffer(RESCUE_MAX_BYTES + 2), 16_000],
  ])("%s → skipped, в облако не идёт", async (_n, pcm, sr) => {
    const { r, transcribe } = judge();
    expect(await r.judge(pcm, sr)).toBe("skipped");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("ход уже идёт (не idle) → skipped, в облако не идёт", async () => {
    const { r, transcribe } = judge({ isIdle: () => false });
    expect(await r.judge(PCM, 16_000)).toBe("skipped");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("за время распознавания ход начался иначе → skipped, второй раз не будим", async () => {
    let idle = true;
    const { r, accept } = judge({ isIdle: () => idle, transcribe: vi.fn(async () => { idle = false; return "Джарвис, привет"; }) });
    expect(await r.judge(PCM, 16_000)).toBe("skipped");
    expect(accept).not.toHaveBeenCalled();
  });

  it("сбой облака → skipped, без исключения наружу", async () => {
    const { r, log } = judge({ transcribe: vi.fn(async () => { throw new Error("deepgram REST 503"); }) });
    expect(await r.judge(PCM, 16_000)).toBe("skipped");
    expect(log.warn).toHaveBeenCalled();
  });

  it("слишком частые фрагменты режутся: второй в пределах RESCUE_MIN_GAP_MS → skipped, позже — разбирается", async () => {
    const { r, clock, transcribe } = judge();
    await r.judge(PCM, 16_000);
    clock.t += RESCUE_MIN_GAP_MS - 1;
    expect(await r.judge(PCM, 16_000)).toBe("skipped");
    clock.t += 2;
    expect(await r.judge(PCM, 16_000)).toBe("accepted");
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("параллельный второй фрагмент, пока первый в разборе → skipped", async () => {
    let release: (t: string) => void = () => {};
    const transcribe = vi.fn(() => new Promise<string>((res) => { release = res; }));
    const { r, clock } = judge({ transcribe });
    const first = r.judge(PCM, 16_000);
    clock.t += RESCUE_MIN_GAP_MS * 2;
    expect(await r.judge(PCM, 16_000)).toBe("skipped");
    release("Джарвис");
    expect(await first).toBe("accepted");
  });

  it("потолок в час: после RESCUE_MAX_PER_HOUR разборов подстраховка молчит; через час снова работает", async () => {
    const { r, clock, transcribe } = judge({ transcribe: vi.fn(async () => "фон") });
    for (let i = 0; i < RESCUE_MAX_PER_HOUR; i += 1) {
      clock.t += RESCUE_MIN_GAP_MS + 1;
      expect(await r.judge(PCM, 16_000)).toBe("rejected");
    }
    clock.t += RESCUE_MIN_GAP_MS + 1;
    expect(await r.judge(PCM, 16_000)).toBe("skipped");
    expect(transcribe).toHaveBeenCalledTimes(RESCUE_MAX_PER_HOUR);
    clock.t += 3_600_001;
    expect(await r.judge(PCM, 16_000)).toBe("rejected");
  });
});

// ---------- настоящий VoicePipeline ----------
class NullStt implements SttStream {
  readonly live = false;
  onPartial() {}
  onError() {}
  onClose() {}
  pushAudio() {}
  async close() {}
}
class RescueStt implements ISttProvider {
  readonly live = false;
  transcribeOnce = vi.fn(async (_pcm: ArrayBuffer, _sr: number) => "Джарвис, ты меня слышишь?");
  open(): SttStream {
    return new NullStt();
  }
}
class NullTts implements ITtsProvider {
  readonly live = false;
  synthesize(): TtsStream {
    return { onChunk() {}, onError() {}, onDone() {}, cancel() {} } as unknown as TtsStream;
  }
}
function pipeline(stt: ISttProvider, extra: { onUserTurn?: ReturnType<typeof vi.fn>; onWakeRescue?: ReturnType<typeof vi.fn> } = {}) {
  const states: VoiceState[] = [];
  const onUserTurn = extra.onUserTurn ?? vi.fn(async () => ({ voice: "Слышу, сэр." }));
  const pipe = new VoicePipeline({
    stt,
    tts: new NullTts(),
    onUserTurn,
    sendSpeakChunk: (_c: TtsChunk) => {},
    sendClientState: (s) => states.push(s),
    requireWakeWord: true,
    followupMs: 20,
    ...(extra.onWakeRescue ? { onWakeRescue: extra.onWakeRescue } : {}),
  });
  return { pipe, states, onUserTurn };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("VoicePipeline.rescueWake: настоящий конвейер", () => {
  it("фрагмент с «Джарвис» в покое → ход запущен, команда без обращения, метрика accepted", async () => {
    const stt = new RescueStt();
    const onWakeRescue = vi.fn();
    const { pipe, onUserTurn, states } = pipeline(stt, { onWakeRescue });
    expect(await pipe.rescueWake(PCM, 16_000, { ms: 1500 })).toBe("accepted");
    await settle();
    expect(stt.transcribeOnce).toHaveBeenCalledTimes(1);
    expect(onUserTurn).toHaveBeenCalledTimes(1);
    expect(String((onUserTurn.mock.calls[0] as unknown[])[0])).toMatch(/слышишь/u);
    expect(String((onUserTurn.mock.calls[0] as unknown[])[0])).not.toMatch(/джарвис/iu);
    expect(states).toContain("thinking");
    expect(onWakeRescue).toHaveBeenCalledWith("accepted", 1500);
  });

  it("голое «Джарвис» — тоже ход (модель/перехват ответит «Слушаю»)", async () => {
    const stt = new RescueStt();
    stt.transcribeOnce.mockResolvedValue("Джарвис.");
    const { pipe, onUserTurn } = pipeline(stt);
    expect(await pipe.rescueWake(PCM, 16_000)).toBe("accepted");
    await settle();
    expect(onUserTurn).toHaveBeenCalledTimes(1);
  });

  it("фрагмент без обращения → rejected, агент не разбужен, конвейер в покое", async () => {
    const stt = new RescueStt();
    stt.transcribeOnce.mockResolvedValue("ну и что он тебе ответил");
    const onWakeRescue = vi.fn();
    const { pipe, onUserTurn } = pipeline(stt, { onWakeRescue });
    expect(await pipe.rescueWake(PCM, 16_000)).toBe("rejected");
    await settle();
    expect(onUserTurn).not.toHaveBeenCalled();
    expect(pipe.state).toBe("idle");
    expect(onWakeRescue).toHaveBeenCalledWith("rejected", undefined);
  });

  it("ход уже идёт → фрагмент не разбирается и текущий ход не перебивается", async () => {
    const stt = new RescueStt();
    const { pipe, onUserTurn } = pipeline(stt);
    pipe.onWake(); // listening — как после обычного «Джарвис»
    expect(await pipe.rescueWake(PCM, 16_000)).toBe("skipped");
    expect(stt.transcribeOnce).not.toHaveBeenCalled();
    expect(onUserTurn).not.toHaveBeenCalled();
  });

  it("провайдер без разового распознавания (mock/whisper) → skipped, без исключения", async () => {
    const stt: ISttProvider = { live: false, open: () => new NullStt() };
    const { pipe } = pipeline(stt);
    expect(await pipe.rescueWake(PCM, 16_000)).toBe("skipped");
  });
});

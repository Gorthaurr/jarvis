/**
 * §10 realtime: пофразный путь пайплайна (onUserTurnStream). Ключевое — ОДНА speaking-
 * сессия на несколько фраз: speak_start один раз, speak_done один раз (после последней),
 * корректный возврат в listening+follow-up, barge-in рубит весь стрим, а одиночная фраза
 * ведёт себя как раньше (0 регрессий на частом кейсе).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ISttProvider,
  ITtsProvider,
  SttPartial,
  SttStream,
  TtsChunk,
  TtsStream,
} from "../integrations/voice-providers.js";
import type { Logger } from "@jarvis/shared";
import { type ReplySink, VoicePipeline, type VoicePipelineDeps } from "./pipeline.js";
import type { VoiceState } from "./state.js";
import type { FillerCache } from "./filler-cache.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Фейковый прекеш-филлер: всегда готов, pick отдаёт 4 байта (для тестов тайминга §10). */
function fakeFiller(): FillerCache {
  return { ready: true, size: 1, pick: () => new ArrayBuffer(4) } as unknown as FillerCache;
}

class CtrlSttStream implements SttStream {
  readonly live = false;
  private partial?: (p: SttPartial) => void;
  onPartial(cb: (p: SttPartial) => void) {
    this.partial = cb;
  }
  onError() {}
  onClose() {}
  pushAudio() {}
  emit(p: SttPartial) {
    this.partial?.(p);
  }
  async close() {}
}
class CtrlSttProvider implements ISttProvider {
  readonly live = false;
  last: CtrlSttStream | null = null;
  open(): SttStream {
    this.last = new CtrlSttStream();
    return this.last;
  }
}
class CtrlTtsStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private doneCb?: () => void;
  private _cancelled = false;
  constructor(readonly text: string) {}
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
  push(seq = 0, last = true) {
    this.chunkCb?.({ audio: new ArrayBuffer(1), seq, last });
  }
  finishStream() {
    this.doneCb?.();
  }
}
class CtrlTtsProvider implements ITtsProvider {
  readonly live = false;
  streams: CtrlTtsStream[] = [];
  synthesize(text: string): TtsStream {
    const s = new CtrlTtsStream(text);
    this.streams.push(s);
    return s;
  }
}

function make(opts: Partial<VoicePipelineDeps> = {}) {
  const stt = new CtrlSttProvider();
  const tts = new CtrlTtsProvider();
  const states: VoiceState[] = [];
  const chunks: TtsChunk[] = [];
  let sink: ReplySink | null = null;
  let resolveStream: () => void = () => {};
  const pipe = new VoicePipeline({
    stt,
    tts,
    onUserTurn: async () => ({ voice: "не используется" }),
    onUserTurnStream: (_text: string, s: ReplySink) => {
      sink = s;
      return new Promise<void>((res) => {
        resolveStream = res;
      });
    },
    sendSpeakChunk: (c) => chunks.push(c),
    sendClientState: (s) => states.push(s),
    followupMs: 50,
    ...opts,
  });
  return { stt, tts, pipe, states, chunks, getSink: () => sink!, endStream: () => resolveStream() };
}

async function startTurn(h: ReturnType<typeof make>, text = "привет") {
  h.pipe.onWake();
  h.stt.last!.emit({ text, final: true });
  await flush();
}

describe("VoicePipeline пофразный стрим (§10)", () => {
  it("две фразы: speak_start один раз, серийный синтез, speak_done → listening+follow-up", async () => {
    const h = make();
    await startTurn(h);
    expect(h.pipe.state).toBe("thinking");
    const sink = h.getSink();

    sink.sentence("Первое предложение.");
    expect(h.tts.streams).toHaveLength(1);
    h.tts.streams[0]!.push();
    expect(h.pipe.state).toBe("speaking"); // вошли в speaking на первом звуке

    sink.sentence("Второе предложение."); // в очередь, пока синтезируется первая
    expect(h.tts.streams).toHaveLength(1);
    h.tts.streams[0]!.finishStream(); // первая готова → синтез второй
    expect(h.tts.streams).toHaveLength(2);
    expect(h.tts.streams[1]!.text).toBe("Второе предложение.");

    sink.done("Первое предложение. Второе предложение.");
    expect(h.pipe.state).toBe("speaking"); // ещё говорим вторую
    h.tts.streams[1]!.push();
    h.tts.streams[1]!.finishStream(); // последняя готова → speak_done

    expect(h.pipe.state).toBe("listening"); // follow-up окно
    expect(h.states.filter((s) => s === "speaking")).toHaveLength(1); // ровно один вход в speaking
    expect(h.chunks).toHaveLength(2);
    h.endStream();
  });

  it("одиночная фраза ведёт себя как раньше (speaking → done → listening)", async () => {
    const h = make();
    await startTurn(h, "который час");
    const sink = h.getSink();
    sink.sentence("Сейчас три часа.");
    h.tts.streams[0]!.push(0, true);
    expect(h.pipe.state).toBe("speaking");
    sink.done("Сейчас три часа.");
    h.tts.streams[0]!.finishStream();
    expect(h.pipe.state).toBe("listening");
    h.endStream();
  });

  it("done без стрима (детерминированный путь) произносит реплику целиком", async () => {
    const h = make();
    await startTurn(h);
    const sink = h.getSink();
    sink.done("Здравствуйте, сэр."); // ничего не стримилось → speaker произносит full
    expect(h.tts.streams).toHaveLength(1);
    expect(h.tts.streams[0]!.text).toBe("Здравствуйте, сэр.");
    h.tts.streams[0]!.push();
    expect(h.pipe.state).toBe("speaking");
    h.tts.streams[0]!.finishStream();
    expect(h.pipe.state).toBe("listening");
    h.endStream();
  });

  it("barge-in посреди стрима рубит синтез и очередь, поздние фразы глохнут", async () => {
    const h = make();
    await startTurn(h, "расскажи анекдот");
    const sink = h.getSink();
    sink.sentence("Раз.");
    h.tts.streams[0]!.push();
    expect(h.pipe.state).toBe("speaking");

    h.pipe.onVadEvent("barge_in");
    expect(h.tts.streams[0]!.cancelled).toBe(true);
    expect(h.pipe.state).toBe("listening");

    // brain ещё генерирует и шлёт фразы/финал — всё устарело (gen), глохнет.
    sink.sentence("Два.");
    sink.done("Раз. Два.");
    expect(h.tts.streams).toHaveLength(1); // вторую не синтезировали
    expect(h.pipe.state).toBe("listening");
    h.endStream();
  });

  it("синтез фразы без единого чанка (ошибка TTS) НЕ вешает цикл в thinking (§10)", async () => {
    // Регресс: ElevenLabs при HTTP-ошибке/таймауте зовёт done БЕЗ chunk → speak_start не было.
    // Раньше speak_done из thinking = noop → вечное зависание. Теперь — возврат к слуху.
    const h = make();
    await startTurn(h);
    expect(h.pipe.state).toBe("thinking");
    const sink = h.getSink();
    sink.sentence("Ответ.");
    expect(h.tts.streams).toHaveLength(1);
    h.tts.streams[0]!.finishStream(); // done БЕЗ push() — ноль аудио-чанков
    sink.done("Ответ.");
    expect(h.pipe.state).toBe("listening"); // не застряли в thinking
    h.endStream();
  });

  it("stop() во время стрима → idle, синтез отменён", async () => {
    const h = make();
    await startTurn(h);
    const sink = h.getSink();
    sink.sentence("Первое.");
    h.tts.streams[0]!.push();
    expect(h.pipe.state).toBe("speaking");
    h.pipe.stop();
    expect(h.pipe.state).toBe("idle");
    expect(h.tts.streams[0]!.cancelled).toBe(true);
    h.endStream();
  });
});

describe("VoicePipeline прекеш-филлер (§10 realtime)", () => {
  it("thinking(): через ~250мс играет филлер первым звуком → speaking", async () => {
    vi.useFakeTimers();
    try {
      const h = make({ filler: fakeFiller() });
      h.pipe.onWake();
      h.stt.last!.emit({ text: "поболтай", final: true });
      await vi.advanceTimersByTimeAsync(0); // дотягиваем до await onUserTurnStream (sink захвачен)
      const sink = h.getSink();
      expect(h.pipe.state).toBe("thinking");

      sink.thinking?.(); // brain пошёл к LLM
      expect(h.chunks).toHaveLength(0); // ещё тишина (Opus думает)
      await vi.advanceTimersByTimeAsync(260); // > FILLER_DELAY_MS
      expect(h.chunks).toHaveLength(1); // филлер отправлен ПЕРВЫМ звуком
      expect(h.pipe.state).toBe("speaking"); // вошли в speaking на филлере

      // Реальная реплика подъезжает следом и встаёт за филлером.
      sink.sentence("Привет, сэр.");
      h.tts.streams[0]!.push();
      sink.done("Привет, сэр.");
      h.tts.streams[0]!.finishStream();
      expect(h.pipe.state).toBe("listening");
      h.endStream();
    } finally {
      vi.useRealTimers();
    }
  });

  it("реплика РАНЬШЕ 250мс отменяет филлер (Opus успел) — лишнего звука нет", async () => {
    vi.useFakeTimers();
    try {
      const h = make({ filler: fakeFiller() });
      h.pipe.onWake();
      h.stt.last!.emit({ text: "привет", final: true });
      await vi.advanceTimersByTimeAsync(0);
      const sink = h.getSink();
      sink.thinking?.();
      sink.sentence("Здравствуйте."); // подоспела до таймера → отменяет филлер
      h.tts.streams[0]!.push();
      await vi.advanceTimersByTimeAsync(300);
      expect(h.chunks).toHaveLength(1); // только реплика, филлера НЕТ
      h.endStream();
    } finally {
      vi.useRealTimers();
    }
  });

  it("barge-in во время раздумья отменяет отложенный филлер", async () => {
    vi.useFakeTimers();
    try {
      const h = make({ filler: fakeFiller() });
      h.pipe.onWake();
      h.stt.last!.emit({ text: "расскажи", final: true });
      await vi.advanceTimersByTimeAsync(0);
      const sink = h.getSink();
      sink.thinking?.();
      h.pipe.onVadEvent("barge_in"); // перебил, пока Opus думал
      await vi.advanceTimersByTimeAsync(300);
      expect(h.chunks).toHaveLength(0); // филлер НЕ проигран
      expect(h.pipe.state).toBe("listening");
      h.endStream();
    } finally {
      vi.useRealTimers();
    }
  });

  it("без филлера (нет FillerCache) thinking() — no-op, тишина до реплики", async () => {
    vi.useFakeTimers();
    try {
      const h = make(); // без филлера
      h.pipe.onWake();
      h.stt.last!.emit({ text: "поболтай", final: true });
      await vi.advanceTimersByTimeAsync(0);
      const sink = h.getSink();
      sink.thinking?.();
      await vi.advanceTimersByTimeAsync(300);
      expect(h.chunks).toHaveLength(0); // нет филлера → тишина
      expect(h.pipe.state).toBe("thinking");
      h.endStream();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Лог-приёмник: строки сообщений (строка «latency: …» — то, что читает аудит прод-логов). */
function captureLog(lines: string[]): Logger {
  const log: Logger = {
    debug() {},
    info: (m) => void lines.push(m),
    warn: (m) => void lines.push(m),
    error: (m) => void lines.push(m),
    child: () => log,
  };
  return log;
}

/**
 * 🔴 Аудит прод-логов 27.09 (B4): 69 % строк «latency:» — «оборот неполный», firstAudioMs отрицательный.
 * Трекер был ОДИН на пайплайн: речь в раздумье открывает новый STT-лиз (turnSeq++, трекер сброшен), пока
 * прошлый ход ещё думает, — звук его ответа ложился в трекер НОВОГО хода (метка «первая побеждает»), а чанки
 * тегались живым turnSeq, и ack клиента не сходился со снапшотом хода — mouth-to-ear терялся молча.
 */
describe("B4: латентность по ходам — звук прошлого ответа не протекает в новый ход", () => {
  /** Ход 1 → речь в раздумье (лиз 2) → ответ хода 1 звучит → ход 2 из лиза 2 → его первый звук. Часы ручные. */
  async function overlappedTurns() {
    const clock = { t: 10_000 };
    const lines: string[] = [];
    const m2e = vi.fn();
    const h = make({ now: () => clock.t, log: captureLog(lines), onMouthToEar: m2e, followupMs: 60_000 });
    h.pipe.onWake();
    clock.t = 11_000;
    h.stt.last!.emit({ text: "какая погода", final: true }); // turn_end хода 1
    await flush();
    const sink1 = h.getSink();
    clock.t = 11_500;
    h.pipe.onVadEvent("speech_start"); // речь в раздумье → лиз 2 открыт, ход 1 жив
    clock.t = 13_000;
    sink1.sentence("Пасмурно, плюс восемь."); // ответ хода 1 пошёл уже при лизе 2
    h.tts.streams[0]!.push();
    h.pipe.onAudioPlayed(h.chunks[0]!.gen!, 13_100); // клиент эхом вернул тег СВОЕГО чанка
    sink1.done("Пасмурно, плюс восемь.");
    h.tts.streams[0]!.finishStream(); // speak_done → listening (лиз 2 так и открыт)
    h.endStream();
    await flush();
    clock.t = 15_000;
    h.stt.last!.emit({ text: "а завтра", final: true }); // turn_end хода 2
    await flush();
    clock.t = 16_000;
    h.getSink().sentence("Завтра солнце.");
    h.tts.streams[1]!.push(); // первый звук хода 2
    h.endStream();
    return { latency: lines.filter((l) => l.startsWith("latency:")), m2e };
  }

  let prevEarcon: string | undefined;
  beforeEach(() => {
    prevEarcon = process.env.JARVIS_THINK_EARCON_MS;
    process.env.JARVIS_THINK_EARCON_MS = "0"; // тик раздумья по реальному таймеру сценарию не нужен
  });
  afterEach(() => {
    if (prevEarcon === undefined) delete process.env.JARVIS_THINK_EARCON_MS;
    else process.env.JARVIS_THINK_EARCON_MS = prevEarcon;
  });

  it("чанки ответа хода 1 несут тег хода 1 — ack клиента замыкает его mouth-to-ear", async () => {
    const { m2e } = await overlappedTurns();
    expect(m2e).toHaveBeenCalledWith(2_100, 1, "answer"); // 13 100 − 11 000; с тегом живого turnSeq ack терялся
  });

  it("строки latency: полные у обоих ходов — чужой звук не делает firstAudioMs отрицательным", async () => {
    const { latency } = await overlappedTurns();
    expect(latency).toHaveLength(2);
    expect(latency[0]).toContain("→звук 2000мс"); // ход 1: его turn_end не стёрт открытием лиза 2
    expect(latency[1]).toContain("→звук 1000мс"); // ход 2: 15 000 → 16 000, звук хода 1 не в счёт
    expect(latency.join(" | ")).not.toContain("неполный");
  });

  it("проактив между ходами (напоминание в окне follow-up) не засчитан первым звуком следующего хода", async () => {
    const clock = { t: 10_000 };
    const lines: string[] = [];
    const h = make({ now: () => clock.t, log: captureLog(lines), followupMs: 60_000 });
    await startTurn(h, "который час"); // turn_end хода 1
    h.getSink().done("Десять утра.");
    h.tts.streams[0]!.push();
    h.tts.streams[0]!.finishStream(); // speak_done → follow-up: открыт лиз 2
    h.endStream();
    await flush();
    clock.t = 12_000;
    h.pipe.setClientPlayback(false); // клиент доиграл ответ
    h.pipe.speakQueued("Напоминание: созвон в полдень.", true); // срочное звучит в окне follow-up — без тега хода
    h.tts.streams[1]!.push();
    h.tts.streams[1]!.finishStream();
    clock.t = 15_000;
    h.stt.last!.emit({ text: "поставь таймер", final: true }); // turn_end хода 2 (тот же лиз 2)
    await flush();
    clock.t = 15_800;
    h.getSink().sentence("Поставил, сэр.");
    h.tts.streams[2]!.push();
    h.endStream();
    const latency = lines.filter((l) => l.startsWith("latency:"));
    expect(latency).toHaveLength(2); // по строке на ход; ничья речь строку не пишет
    expect(latency[1]).toContain("→звук 800мс"); // не 12 000 − 15 000 < 0 («оборот неполный»)
  });
});

/**
 * A3 (аудит 27.09), прод-путь: предупреждение о непроговорённом итоге цеплялось только к ОЧЕРЕДНОЙ речи, а её
 * в полном экране busy-гейт не выпускал — владелец о потере не узнавал. Теперь оно звучит в следующей реплике
 * любого происхождения, в т.ч. в первой фразе стрим-ответа хода. Вид фразы (ack промоушена) определяется по её
 * собственному тексту — приставка его не ломает (иначе first-sound хода записался бы как «answer»).
 */
describe("A3: потеря названа вслух в первой фразе стрим-ответа хода", () => {
  it("протухший итог → следующий ack хода несёт предупреждение и остаётся ack для mouth-to-ear", async () => {
    const clock = { t: 50_000 };
    const m2e = vi.fn();
    const h = make({ now: () => clock.t, onMouthToEar: m2e });
    await startTurn(h, "найди отчёт за сентябрь");
    h.pipe.speakQueued("Итог, который протух."); // канал занят раздумьем → в очередь
    clock.t += 3 * 60_000; // пролежал дольше TTL
    h.pipe.drainPending(); // выброшен — счётчик потерь +1
    h.getSink().done("Берусь, сэр.", { ack: true, origin: "proactive" }); // промоушен: служебный ack хода
    expect(h.tts.streams).toHaveLength(1);
    expect(h.tts.streams[0]!.text).toMatch(/не успел проговорить/);
    expect(h.tts.streams[0]!.text).toContain("Берусь, сэр.");
    h.tts.streams[0]!.push();
    h.pipe.onAudioPlayed(h.chunks[0]!.gen!, clock.t + 100);
    expect(m2e).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), "ack");
    h.endStream();
  });
});

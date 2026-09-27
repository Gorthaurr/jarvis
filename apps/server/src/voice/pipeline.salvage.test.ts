/**
 * Спасённая реплика отменённого хода (salvage) — адверс-ревью р1 A3 (аудит 27.09).
 *
 * A3 сделал спасённый ответ «ответом владельцу» (origin user-turn: busy-гейт пропускает, окно разговора открывается,
 * first_answer закрывается). Ревью нашло два перегиба:
 *  1) salvage игнорировал opts done(): служебный ack промоушена «Берусь, сэр» (T-F6 — проактив) спасался как ответ —
 *     звучал поверх полного экрана, открывал окно (звук комнаты = команда) и закрывал first_answer на «Берусь»;
 *  2) salvage игнорировал адресацию хода: ход, принятый ОКНОМ без «Джарвис» (фильм/комната), тоже бил busy-гейт
 *     и сам продлевал окно — прямая подпитка открытой P1 A2.
 * Плюс настоящий спасённый ответ писался в first_answer путём "promoted" — это не итог фоновой задачи.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ISttProvider, ITtsProvider, SttPartial, SttStream, TtsChunk, TtsStream } from "../integrations/voice-providers.js";
import { type ReplySink, VoicePipeline, type VoicePipelineDeps } from "./pipeline.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

class CtrlSttStream implements SttStream {
  readonly live = false;
  private partial?: (p: SttPartial) => void;
  onPartial(cb: (p: SttPartial) => void) { this.partial = cb; }
  onError() {}
  onClose() {}
  pushAudio() {}
  emit(p: SttPartial) { this.partial?.(p); }
  async close() {}
}
class CtrlSttProvider implements ISttProvider {
  readonly live = false;
  last: CtrlSttStream | null = null;
  open(): SttStream { this.last = new CtrlSttStream(); return this.last; }
}
class CtrlTtsStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private doneCb?: () => void;
  constructor(readonly text: string) {}
  onChunk(cb: (c: TtsChunk) => void) { this.chunkCb = cb; }
  onError() {}
  onDone(cb: () => void) { this.doneCb = cb; }
  cancelled = false;
  cancel() { this.cancelled = true; }
  push() { this.chunkCb?.({ audio: new ArrayBuffer(1), seq: 0, last: true }); }
  finishStream() { this.doneCb?.(); }
}
class CtrlTtsProvider implements ITtsProvider {
  readonly live = false;
  streams: CtrlTtsStream[] = [];
  synthesize(text: string): TtsStream { const s = new CtrlTtsStream(text); this.streams.push(s); return s; }
  get texts(): string[] { return this.streams.map((s) => s.text); }
}

/** Стрим-пайплайн: каждый ход — свой sink (ходы перекрываются), часы ручные, «занят» управляемый. */
function make(opts: Partial<VoicePipelineDeps> = {}) {
  const clock = { t: 100_000 };
  const busy = { value: true };
  const stt = new CtrlSttProvider();
  const tts = new CtrlTtsProvider();
  const sinks: ReplySink[] = [];
  const resolvers: (() => void)[] = [];
  const chat: string[] = [];
  const firstAnswer = vi.fn();
  const pipe = new VoicePipeline({
    stt, tts,
    onUserTurn: async () => ({ voice: "не используется" }),
    onUserTurnStream: (_t: string, s: ReplySink) => { sinks.push(s); return new Promise<void>((res) => resolvers.push(res)); },
    sendSpeakChunk: () => {}, sendClientState: () => {},
    sendChat: (m) => void (m.role === "assistant" && chat.push(m.text)),
    isUserBusy: () => busy.value,
    onFirstAnswer: firstAnswer,
    now: () => clock.t,
    followupMs: 60_000,
    ...opts,
  });
  const say = async (text: string) => { h.stt.last!.emit({ text, final: true }); await flush(); };
  const h = { stt, tts, pipe, sinks, resolvers, chat, firstAnswer, clock, busy, say };
  return h;
}

let prevEarcon: string | undefined;
beforeEach(() => {
  prevEarcon = process.env.JARVIS_THINK_EARCON_MS;
  process.env.JARVIS_THINK_EARCON_MS = "0";
});
afterEach(() => {
  if (prevEarcon === undefined) delete process.env.JARVIS_THINK_EARCON_MS;
  else process.env.JARVIS_THINK_EARCON_MS = prevEarcon;
});

/** Ход 1 «Джарвис, …» (адресован) → речь в раздумье → ход 2 отменяет ход 1 (один ход за раз). */
async function cancelledAddressedTurn(h: ReturnType<typeof make>) {
  h.pipe.onWake();
  await h.say("найди отчёт за сентябрь"); // ход 1
  h.pipe.onVadEvent("speech_start"); // владелец заговорил снова — лиз 2
  await h.say("и открой почту"); // ход 2 отменяет ход 1
  expect(h.sinks).toHaveLength(2);
}

describe("salvage уважает opts done(): ack промоушена — не ответ владельцу", () => {
  it("занят: спасённый «Берусь» не звучит (текст — в чат), first_answer хода закрывает настоящий итог задачи", async () => {
    const h = make();
    await cancelledAddressedTurn(h);
    h.sinks[0]!.done("Берусь, сэр.", { origin: "proactive", ack: true }); // brain/agent/index.ts: промоушен хода 1
    h.sinks[1]!.done("Открыл почту, сэр."); // ход 2 отвечает прямо
    h.tts.streams[0]!.push();
    h.tts.streams[0]!.finishStream();
    h.resolvers.forEach((r) => r());
    await flush();
    h.clock.t += 5_000;
    h.pipe.setClientPlayback(false); // динамик свободен — очередь дренируется
    expect(h.tts.texts).toEqual(["Открыл почту, сэр."]); // «Берусь» устарел: владелец уже дал новую команду
    expect(h.chat).toContain("Берусь, сэр."); // текст не пропал
    expect(h.firstAnswer.mock.calls.filter((c) => c[1] === 1)).toEqual([]); // ack — не ответ хода 1
    // Итог промотированной задачи хода 1 приходит speakResult'ом (router-ws: origin user-turn + answerOf).
    h.pipe.speakQueued("Отчёт за сентябрь готов, сэр.", true, { origin: "user-turn", answerOf: 1 });
    h.tts.streams.at(-1)!.push();
    expect(h.firstAnswer.mock.calls.filter((c) => c[1] === 1)).toEqual([[expect.any(Number), 1, "promoted"]]);
  });

  it("ack отменённого хода не закрывает окно разговора НОВОГО хода (ответ хода 2 оставляет окно открытым)", async () => {
    const h = make({ requireWakeWord: true });
    h.busy.value = false;
    h.pipe.onWake();
    await h.say("Джарвис, найди отчёт за сентябрь"); // ход 1
    h.clock.t += 5_000;
    h.pipe.onVadEvent("speech_start");
    await h.say("Джарвис, открой почту"); // ход 2 отменяет ход 1
    h.clock.t += 1_000;
    h.sinks[0]!.done("Берусь, сэр.", { origin: "proactive", ack: true }); // запоздалый ack хода 1
    h.clock.t += 2_000;
    h.sinks[1]!.done("Открыл почту, сэр.");
    h.tts.streams[0]!.push();
    h.tts.streams[0]!.finishStream(); // ответ владельцу → окно разговора от момента, когда Джарвис замолчал
    h.resolvers.forEach((r) => r());
    await flush();
    h.clock.t += 6_000; // 6 с после ответа — окно (12 с) ещё открыто
    await h.say("а теперь календарь"); // продолжение без «Джарвис»
    expect(h.sinks).toHaveLength(3);
  });
});

describe("salvage уважает адресацию хода: принятое окном без «Джарвис» — проактив", () => {
  /** Адресованный ход A отзвучал → фраза фильма в окне (ход B) → ещё фраза отменяет B (ход C) → B договорил. */
  async function filmChain(h: ReturnType<typeof make>) {
    h.pipe.onWake();
    await h.say("Джарвис, включи фильм"); // ход A — явное обращение
    h.sinks[0]!.done("Включаю, сэр.");
    h.tts.streams[0]!.push();
    h.tts.streams[0]!.finishStream(); // speak_done → окно разговора
    h.resolvers[0]!();
    await flush();
    h.clock.t += 1_000;
    await h.say("он ушёл из дома в пятницу"); // ход B — звук фильма, принят ОКНОМ
    h.clock.t += 1_000;
    h.pipe.onVadEvent("speech_start");
    await h.say("и больше никто его не видел"); // ход C (тоже окном) отменяет B
    expect(h.sinks).toHaveLength(3);
    h.sinks[1]!.done("Это фильм о побеге, сэр."); // B договорил после отмены → salvage
    h.sinks[2]!.done(""); // C — тихий финал
    h.resolvers.forEach((r) => r());
    await flush();
  }

  it("занят (полный экран): спасённая реплика неадресованного хода ДЕРЖИТСЯ busy-гейтом, как проактив", async () => {
    const h = make({ requireWakeWord: true });
    await filmChain(h);
    expect(h.tts.texts).not.toContain("Это фильм о побеге, сэр.");
    h.busy.value = false; // вышел из полного экрана
    h.pipe.drainPending();
    expect(h.tts.texts).toContain("Это фильм о побеге, сэр."); // не потеряна — отдана по освобождении
  });

  it("не занят: звучит, но окно разговора НЕ продлевает — следующая фраза фильма командой не становится", async () => {
    const h = make({ requireWakeWord: true });
    h.busy.value = false;
    h.pipe.onWake();
    await h.say("Джарвис, включи фильм");
    h.sinks[0]!.done("Включаю, сэр.");
    h.tts.streams[0]!.push();
    h.tts.streams[0]!.finishStream();
    h.resolvers[0]!();
    await flush();
    h.clock.t += 1_000;
    await h.say("он ушёл из дома в пятницу"); // ход B (окном)
    h.clock.t += 1_000;
    h.pipe.onVadEvent("speech_start");
    await h.say("и больше никто его не видел"); // ход C отменяет B
    h.sinks[2]!.done(""); // C молча закрылся раньше, чем B договорил
    h.resolvers.forEach((r) => r());
    await flush();
    h.clock.t += 13_000; // окно разговора (12 с от последней активности) истекло
    h.sinks[1]!.done("Это фильм о побеге, сэр."); // salvage B → очередь → звучит сразу (канал свободен)
    const salvaged = h.tts.streams.find((s) => s.text === "Это фильм о побеге, сэр.");
    expect(salvaged).toBeDefined();
    salvaged!.push();
    salvaged!.finishStream(); // speak_done → follow-up, но окно проактив не открывает
    await h.say("а потом его нашли в лесу");
    expect(h.sinks).toHaveLength(3); // фраза фильма без «Джарвис» в мозг не ушла
  });

  it("классический путь (onUserTurn без стрима): адресация хода тоже учитывается", async () => {
    const answers: ((r: { voice: string }) => void)[] = [];
    const h = make({ requireWakeWord: true, onUserTurnStream: undefined, onUserTurn: () => new Promise((res) => void answers.push(res)) });
    h.pipe.onWake();
    await h.say("Джарвис, включи фильм"); // ход A
    answers[0]!({ voice: "Включаю, сэр." });
    await flush();
    h.tts.streams[0]!.push();
    h.tts.streams[0]!.finishStream(); // speak_done → окно разговора
    h.clock.t += 1_000;
    await h.say("он ушёл из дома в пятницу"); // ход B — окном
    h.clock.t += 1_000;
    h.pipe.onVadEvent("speech_start");
    await h.say("и больше никто его не видел"); // ход C отменяет B
    answers[1]!({ voice: "Это фильм о побеге, сэр." }); // salvage B
    answers[2]!({ voice: "Не понял, сэр." });
    await flush();
    h.tts.streams.at(-1)!.push();
    h.tts.streams.at(-1)!.finishStream();
    h.clock.t += 2_000;
    h.pipe.setClientPlayback(false);
    expect(h.tts.texts).not.toContain("Это фильм о побеге, сэр."); // занят — проактив держится
  });
});

/**
 * Финальное ревью р2 (аудит 27.09): очередь озвучки полна непереигрываемым (срочное/retriable) — salvage получает
 * отказ, а лог рапортовал «голос в очередь», и потеря не считалась: владелец не слышал ни ответа, ни «не успел».
 */
describe("salvage при полной очереди: отказ — честно и с учётом потери", () => {
  it("лог говорит «НЕ принят», а следующая речь несёт предупреждение о непроговорённом", async () => {
    const warns: string[] = [];
    const log = { debug() {}, info() {}, error() {}, warn: (m: string) => void warns.push(m), child() { return log; } };
    const h = make({ log });
    h.pipe.onWake();
    await h.say("найди отчёт за сентябрь"); // ход 1 думает — очередь держит
    for (let i = 1; i <= 4; i += 1) h.pipe.speakQueued(`Напоминание ${i}.`, true, { retriable: true });
    h.pipe.onVadEvent("speech_start");
    await h.say("и открой почту"); // ход 2 отменяет ход 1
    h.sinks[0]!.done("Отчёт за сентябрь в папке «Документы», сэр."); // salvage → очередь полна, жертвы нет
    expect(h.chat).toContain("Отчёт за сентябрь в папке «Документы», сэр."); // текст не пропал
    expect(warns.some((m) => m.includes("НЕ принят"))).toBe(true);
    expect(warns.some((m) => m.includes("голос в очередь"))).toBe(false);
    h.sinks[1]!.done("Открыл почту, сэр."); // прямой ответ хода 2 — носитель предупреждения
    expect(h.tts.texts.at(-1)).toMatch(/не успел проговорить/);
  });
});

describe("классический путь (JARVIS_VOICE_STREAMING=0): ack промоушена не спасается как ответ", () => {
  it("занят: спасённый «Берусь» отменённого адресованного хода не звучит, текст — в чат", async () => {
    const answers: ((r: { voice: string; ack?: boolean }) => void)[] = [];
    const h = make({ onUserTurnStream: undefined, onUserTurn: () => new Promise((res) => void answers.push(res)) });
    h.pipe.onWake();
    await h.say("найди отчёт за сентябрь"); // ход 1 (адресован: wake-гейта нет)
    h.pipe.onVadEvent("speech_start");
    await h.say("и открой почту"); // ход 2 отменяет ход 1
    answers[0]!({ voice: "Берусь, сэр.", ack: true }); // tier0-промоушен хода 1 (brain/agent/index.ts)
    answers[1]!({ voice: "Открыл почту, сэр." });
    await flush();
    h.tts.streams.at(-1)!.push();
    h.tts.streams.at(-1)!.finishStream();
    h.clock.t += 2_000;
    h.pipe.setClientPlayback(false); // динамик свободен — очередь дренируется
    expect(h.tts.texts).toEqual(["Открыл почту, сэр."]); // «Берусь» устарел: итог задачи придёт сам
    expect(h.chat).toContain("Берусь, сэр."); // текст не пропал
  });
});

describe("salvage адресованного хода: ответ владельцу (A3), но не «promoted» в first_answer", () => {
  it("занят: спасённый ответ звучит после ответа хода 2, first_answer хода 1 путём promoted НЕ пишется", async () => {
    const h = make();
    await cancelledAddressedTurn(h);
    h.sinks[0]!.done("Отчёт за сентябрь в папке «Документы», сэр."); // ход 1 договорил после отмены
    h.sinks[1]!.done("Открыл почту, сэр.");
    h.tts.streams[0]!.push();
    h.tts.streams[0]!.finishStream();
    h.resolvers.forEach((r) => r());
    await flush();
    h.clock.t += 2_000;
    h.pipe.setClientPlayback(false);
    const salvaged = h.tts.streams.find((s) => s.text.includes("Отчёт за сентябрь"));
    expect(salvaged).toBeDefined(); // A3: ответ на вопрос владельца busy-гейт не держит
    salvaged!.push();
    // Спасённый ответ — не итог фоновой задачи: его «латентность» = длина перебившего хода, не мозга.
    expect(h.firstAnswer.mock.calls.filter((c) => c[1] === 1)).toEqual([]);
  });
});

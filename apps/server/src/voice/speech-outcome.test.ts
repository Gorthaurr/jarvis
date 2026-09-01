/**
 * ЧЕСТНЫЙ ИСХОД ПРОАКТИВНОЙ РЕЧИ: реплика, которую очередь озвучки так и НЕ произнесла, обязана
 * вернуться в состояние «ждёт доставки» у своего durable-источника — напоминаний, наблюдений и
 * ambient. Не «доставлено», а «повторим позже».
 *
 * 🔴 ЖИВОЙ ДЕФЕКТ (волна D, контроль-7..10, класс «речь пропала»). Очередь озвучки ОДНА на все
 * проактивные каналы. Каждый источник, «отдав» реплику, СРАЗУ помечал запись доставленной (`done`,
 * `pendingNotify = undefined`, durable `seen`) — а очередь в этот момент могла её выбросить: TTL,
 * «стоп» владельца, смерть сессии, отказ синтеза. После ночи офлайна три флаша вливали восемь реплик
 * в четыре слота: звучала одна, остальные пропадали НАВСЕГДА — включая срочное напоминание. У этих
 * каналов нет текстовой копии в чате, поэтому владелец не узнавал о потере вообще. Лечение —
 * двусторонний контракт: `speakQueued` возвращает «принята ли реплика», а `onOutcome(spoken)`
 * сообщает РЕАЛЬНЫЙ исход; источник помечает доставленным только по `true` и ОТКАТЫВАЕТ пометку
 * на `false` (`markFiredUndelivered`, возврат `pendingNotify`, `seen.unmark`).
 *
 * ПОЧЕМУ ЮНИТ-ТЕСТЫ ЭТОГО НЕ ЛОВИЛИ: обе половины покрыты порознь. Сервисам в их тестах подсовывают
 * `speak: vi.fn()` — он не возвращает `false` и НИКОГДА не зовёт `onOutcome`, поэтому ветка отката
 * вообще не исполняется. Тесты пайплайна проверяют, что `onOutcome(false)` вызван, но не знают, что
 * с этим делает источник. Дефект живёт РОВНО в проводке: удаление всех шести откатов оставляло
 * прогон зелёным.
 *
 * Поэтому здесь — НАСТОЯЩИЕ `ReminderService` / `WatchService` / `AmbientEngine` против НАСТОЯЩЕГО
 * `VoicePipeline`, а проводка скопирована с `gateway/router-ws.ts` (там же — `verbalize`, который
 * для смысла теста не нужен). Наблюдаемое поведение — прозвучала ли реплика у владельца в итоге,
 * а не наличие строк в исходнике.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ISttProvider,
  ITtsProvider,
  SttStream,
  TtsChunk,
  TtsStream,
} from "../integrations/voice-providers.js";
import { AmbientEngine } from "../proactive/ambient/engine.js";
import type { AmbientSignal, AmbientSource } from "../proactive/ambient/signal.js";
import { AmbientSeenStore } from "../proactive/ambient/store.js";
import { ReminderService } from "../proactive/reminders/service.js";
import { ReminderStore } from "../proactive/reminders/store.js";
import { WatchService } from "../proactive/watch/service.js";
import { WatchStore } from "../proactive/watch/store.js";
import { VoicePipeline } from "./pipeline.js";

// ── песочница ────────────────────────────────────────────────

let dirCounter = 0;
const tempDir = (): string => join(tmpdir(), `jarvis-speech-outcome-${process.pid}-${Date.now()}-${dirCounter++}`);

/** Микротаски (синтез отдаёт чанк/ошибку через queueMicrotask — фейковые таймеры их не трогают). */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

class SilentSttStream implements SttStream {
  readonly live = false;
  onPartial(): void {}
  onError(): void {}
  onClose(): void {}
  pushAudio(): void {}
  async close(): Promise<void> {}
}
class SilentSttProvider implements ISttProvider {
  readonly live = false;
  open(): SttStream {
    return new SilentSttStream();
  }
}

class TestTtsStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private errCb?: (e: Error) => void;
  private doneCb?: () => void;
  private _cancelled = false;
  onChunk(cb: (c: TtsChunk) => void): void {
    this.chunkCb = cb;
  }
  onError(cb: (e: Error) => void): void {
    this.errCb = cb;
  }
  onDone(cb: () => void): void {
    this.doneCb = cb;
  }
  cancel(): void {
    this._cancelled = true;
  }
  get cancelled(): boolean {
    return this._cancelled;
  }
  /** Звук реально ушёл клиенту → пайплайн отчитается onOutcome(true). */
  emitChunk(): void {
    this.chunkCb?.({ audio: new ArrayBuffer(8), seq: 0, last: true });
    this.doneCb?.();
  }
  /** Синтез упал (сеть/квота) — ни одного байта → onOutcome(false). */
  fail(): void {
    this.errCb?.(new Error("TTS недоступен"));
  }
}

/**
 * mode: "speak" — обычный синтез (чанк уходит клиенту); "fail" — провайдер падает, не отдав ни байта.
 * Тексты копятся: «дошло до синтеза» = попало в этот список.
 */
class TestTtsProvider implements ITtsProvider {
  readonly live = false;
  readonly texts: string[] = [];
  constructor(private readonly mode: "speak" | "fail" = "speak") {}
  synthesize(text: string): TtsStream {
    this.texts.push(text);
    const s = new TestTtsStream();
    queueMicrotask(() => (this.mode === "speak" ? s.emitChunk() : s.fail()));
    return s;
  }
}

function makePipe(tts: TestTtsProvider): VoicePipeline {
  return new VoicePipeline({
    stt: new SilentSttProvider(),
    tts,
    onUserTurn: async () => ({ voice: "" }),
    sendSpeakChunk: () => {},
    sendClientState: () => {},
    followupMs: 50,
  });
}

/** Проводка напоминаний/наблюдений — копия router-ws (срочные, retriable, честный исход). */
const urgentSpeaker =
  (pipe: VoicePipeline) =>
  (text: string, onOutcome?: (spoken: boolean) => void): boolean =>
    pipe.speakQueued(text, true, { retriable: true, ...(onOutcome ? { onOutcome } : {}) });

/** Проводка ambient — копия router-ws (urgent решает сигнал). */
const ambientSpeaker =
  (pipe: VoicePipeline) =>
  (text: string, urgent: boolean, onOutcome?: (spoken: boolean) => void): boolean =>
    pipe.speakQueued(text, urgent, { retriable: true, ...(onOutcome ? { onOutcome } : {}) });

const fakeSource = (id: string, signals: () => AmbientSignal[]): AmbientSource => ({
  id,
  label: id,
  enabled: () => true,
  poll: async () => signals(),
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ── напоминания ──────────────────────────────────────────────

describe("напоминания: реплика, не прозвучавшая из очереди, снова ждёт доставки", () => {
  it("«стоп» посреди ожидания в очереди → напоминание НЕ доставлено и звучит на следующем канале", async () => {
    const tts = new TestTtsProvider();
    const pipe = makePipe(tts);
    pipe.setClientPlayback(true); // динамик клиента ещё доигрывает прошлую реплику → очередь ждёт
    const svc = new ReminderService(new ReminderStore(tempDir()));
    await svc.start();
    svc.registerSpeaker("s1", "u1", urgentSpeaker(pipe));

    svc.add({ sessionId: "s1", userId: "u1", text: "Пора пить таблетки", fireAt: Date.now() + 1000 });
    vi.advanceTimersByTime(1000);
    expect(tts.texts).toEqual([]); // сработало, но лежит в очереди — владелец ещё ничего не слышал
    expect(svc.list("u1")).toHaveLength(0); // источник пометил доставленным (принято в очередь)

    pipe.clearPendingSpeech(); // владелец сказал «стоп»/«отмени» — очередь сброшена

    // ЧЕСТНЫЙ ИСХОД: раз не прозвучало — запись обязана вернуться в «ждёт доставки».
    expect(svc.list("u1").map((r) => r.text)).toEqual(["Пора пить таблетки"]);

    // ...и реально дойти до владельца следующим каналом, а не пропасть навсегда.
    svc.unregisterSpeaker("s1");
    const tts2 = new TestTtsProvider();
    svc.registerSpeaker("s2", "u1", urgentSpeaker(makePipe(tts2)));
    await settle();
    expect(tts2.texts).toEqual(["Пора пить таблетки"]);
  });

  it("отложенное (офлайн) напоминание, отданное в УМИРАЮЩУЮ сессию, доезжает до следующей", async () => {
    const svc = new ReminderService(new ReminderStore(tempDir()));
    await svc.start();
    svc.add({ sessionId: "s0", userId: "u1", text: "Позвонить маме", fireAt: Date.now() + 1000 });
    vi.advanceTimersByTime(1000); // сработало в тишину: клиент был закрыт

    const tts = new TestTtsProvider();
    const pipe = makePipe(tts);
    pipe.setClientPlayback(true); // подключился, но динамик занят → реплика в очереди
    svc.registerSpeaker("s1", "u1", urgentSpeaker(pipe)); // flushPending отдаёт отложенное
    expect(tts.texts).toEqual([]);
    expect(svc.list("u1")).toHaveLength(0); // помечено доставленным

    pipe.dispose(); // сессия умерла (обрыв WS) — очередь этой сессии выброшена
    svc.unregisterSpeaker("s1");

    expect(svc.list("u1").map((r) => r.text)).toEqual(["Позвонить маме"]); // снова ждёт доставки

    const tts2 = new TestTtsProvider();
    svc.registerSpeaker("s2", "u1", urgentSpeaker(makePipe(tts2)));
    await settle();
    expect(tts2.texts).toEqual(["Позвонить маме"]);
  });

  it("синтез не дал ни звука (TTS упал) → напоминание не считается доставленным", async () => {
    const tts = new TestTtsProvider("fail");
    const pipe = makePipe(tts);
    const svc = new ReminderService(new ReminderStore(tempDir()));
    await svc.start();
    svc.registerSpeaker("s1", "u1", urgentSpeaker(pipe));

    svc.add({ sessionId: "s1", userId: "u1", text: "Выпить лекарство", fireAt: Date.now() + 1000 });
    vi.advanceTimersByTime(1000);
    expect(tts.texts).toEqual(["Выпить лекарство"]); // синтез НАЧАТ
    expect(svc.list("u1")).toHaveLength(0);

    await settle(); // ...и провалился: ни одного байта клиенту не ушло

    expect(svc.list("u1").map((r) => r.text)).toEqual(["Выпить лекарство"]);
  });

  it("АНТИ-ОВЕРФИТ: реально прозвучавшее напоминание остаётся доставленным и не повторяется", async () => {
    const tts = new TestTtsProvider();
    const svc = new ReminderService(new ReminderStore(tempDir()));
    await svc.start();
    svc.registerSpeaker("s1", "u1", urgentSpeaker(makePipe(tts)));

    svc.add({ sessionId: "s1", userId: "u1", text: "Забрать посылку", fireAt: Date.now() + 1000 });
    vi.advanceTimersByTime(1000);
    await settle(); // чанк ушёл клиенту → прозвучало

    expect(tts.texts).toEqual(["Забрать посылку"]);
    expect(svc.list("u1")).toHaveLength(0); // доставлено — откатывать нечего

    svc.unregisterSpeaker("s1");
    const tts2 = new TestTtsProvider();
    svc.registerSpeaker("s2", "u1", urgentSpeaker(makePipe(tts2)));
    await settle();
    expect(tts2.texts).toEqual([]); // второй раз владельцу не звоним
  });
});

// ── наблюдения ───────────────────────────────────────────────

describe("наблюдения: уведомление, не прозвучавшее из очереди, снова ждёт доставки", () => {
  const metChecker = async () => ({ met: true, value: "доставлен", summary: "Заказ доставлен." });

  it("«стоп» посреди ожидания → pendingNotify возвращается, следующая сессия получает уведомление", async () => {
    const tts = new TestTtsProvider();
    const pipe = makePipe(tts);
    pipe.setClientPlayback(true);
    const svc = new WatchService(metChecker, new WatchStore(tempDir()), { minIntervalMs: 1000 });
    svc.registerSpeaker("s1", "u1", urgentSpeaker(pipe));
    svc.add({ sessionId: "s1", userId: "u1", what: "статус заказа", condition: "доставлен", intervalMs: 1000 });

    await svc.tickNow(); // условие выполнено → уведомление уходит в очередь
    expect(tts.texts).toEqual([]);

    pipe.clearPendingSpeech(); // «стоп» владельца
    svc.unregisterSpeaker("s1");

    const tts2 = new TestTtsProvider();
    svc.registerSpeaker("s2", "u1", urgentSpeaker(makePipe(tts2))); // flushPending
    await settle();
    expect(tts2.texts).toEqual(["Заказ доставлен."]);
  });

  it("отложенное уведомление, отданное в УМИРАЮЩУЮ сессию, доезжает до следующей", async () => {
    const svc = new WatchService(metChecker, new WatchStore(tempDir()), { minIntervalMs: 1000 });
    svc.add({ sessionId: "s0", userId: "u1", what: "статус заказа", condition: "доставлен", intervalMs: 1000 });
    await svc.tickNow(); // сработало без сессии → pendingNotify

    const tts = new TestTtsProvider();
    const pipe = makePipe(tts);
    pipe.setClientPlayback(true);
    svc.registerSpeaker("s1", "u1", urgentSpeaker(pipe)); // flushPending → в очередь
    expect(tts.texts).toEqual([]);

    pipe.dispose(); // сессия умерла — очередь выброшена
    svc.unregisterSpeaker("s1");

    const tts2 = new TestTtsProvider();
    svc.registerSpeaker("s2", "u1", urgentSpeaker(makePipe(tts2)));
    await settle();
    expect(tts2.texts).toEqual(["Заказ доставлен."]);
  });
});

// ── ambient ──────────────────────────────────────────────────

describe("ambient: сигнал, не прозвучавший из очереди, не считается доставленным", () => {
  const mail = (): AmbientSignal => ({
    sourceId: "mail",
    userId: "u1",
    key: "letter-1",
    title: "Вам письмо от Германа.",
    salience: 0.9,
    ts: Date.now(),
  });

  it("реплика протухла в очереди (TTL) → durable-seen откатывается, сигнал звучит следующим тиком", async () => {
    const tts = new TestTtsProvider();
    const pipe = makePipe(tts);
    pipe.setClientPlayback(true); // динамик занят → несрочная реплика ложится в очередь
    const items = [mail()];
    const eng = new AmbientEngine([fakeSource("mail", () => items)], new AmbientSeenStore(tempDir()), {
      minSalience: 0.5,
      quietHours: "",
    });
    eng.registerSpeaker("s1", "u1", ambientSpeaker(pipe));

    await eng.tickNow();
    expect(tts.texts).toEqual([]); // в очереди, владелец ещё не слышал

    vi.advanceTimersByTime(3 * 60_000); // пролежала дольше JARVIS_SPEECH_QUEUE_TTL_MS (деф 120с)
    pipe.setClientPlayback(false); // динамик освободился → дренаж выбрасывает протухшее
    expect(tts.texts).toEqual([]);

    await eng.tickNow(); // seen откатили → сигнал рассматривается снова и наконец звучит
    expect(tts.texts).toEqual(["Вам письмо от Германа."]);
  });

  it("отложенный сигнал, отданный в УМИРАЮЩУЮ сессию, возвращается в ожидание", async () => {
    const items = [mail()];
    const eng = new AmbientEngine([fakeSource("mail", () => items)], new AmbientSeenStore(tempDir()), {
      minSalience: 0.5,
      quietHours: "",
    });
    await eng.tickNow(); // владельца нет → сигнал в pending

    const tts = new TestTtsProvider();
    const pipe = makePipe(tts);
    pipe.setClientPlayback(true);
    eng.registerSpeaker("s1", "u1", ambientSpeaker(pipe)); // flushPending → в очередь
    expect(tts.texts).toEqual([]);

    pipe.dispose(); // сессия умерла
    eng.unregisterSpeaker("s1");

    const tts2 = new TestTtsProvider();
    eng.registerSpeaker("s2", "u1", ambientSpeaker(makePipe(tts2)));
    await settle();
    expect(tts2.texts).toEqual(["Вам письмо от Германа."]);
  });
});

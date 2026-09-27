import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepgramSttProvider } from "./deepgram.js";

type Ev = { data?: unknown; code?: number; reason?: string };

/** Управляемый mock глобального WebSocket: тест сам дёргает open/message/close. */
class MockWS {
  static instances: MockWS[] = [];
  static reset(): void {
    MockWS.instances = [];
  }
  readyState = 0;
  sent: unknown[] = [];
  closeCalls = 0;
  private listeners: Record<string, ((ev: Ev) => void)[]> = {};
  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    MockWS.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: Ev) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls += 1;
    this.fire("close", { code: code ?? 1000, reason: reason ?? "" });
  }
  hasSent(substr: string): boolean {
    return this.sent.some((d) => typeof d === "string" && d.includes(substr));
  }
  fire(type: string, ev: Ev = {}): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

const results = (transcript: string, isFinal: boolean): Ev => ({
  data: JSON.stringify({ type: "Results", is_final: isFinal, channel: { alternatives: [{ transcript }] } }),
});

describe("Deepgram reconnect-in-stream (§10)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWS.reset();
    (globalThis as { WebSocket?: unknown }).WebSocket = MockWS as unknown;
    process.env.JARVIS_DEEPGRAM_PERSISTENT = "0"; // этот блок тестирует per-utterance путь (дефолт теперь ON)
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env.JARVIS_DEEPGRAM_PERSISTENT = undefined;
  });

  it("аномальный обрыв (1006) → переподключение, closeCb НЕ дёргается, committed сохранён", () => {
    const stream = new DeepgramSttProvider("k").open({ sampleRate: 16_000 });
    let closed = false;
    stream.onClose(() => {
      closed = true;
    });
    const partials: string[] = [];
    stream.onPartial((p) => partials.push(p.text));

    const ws1 = MockWS.instances[0]!;
    ws1.fire("open");
    ws1.fire("message", results("привет", true)); // committed = «привет»
    expect(partials.at(-1)).toBe("привет");

    ws1.fire("close", { code: 1006 }); // сетевой обрыв посреди фразы
    expect(closed).toBe(false); // НЕ финализируем — реконнектим
    vi.advanceTimersByTime(300); // backoff
    expect(MockWS.instances.length).toBe(2); // подняли новый сокет

    const ws2 = MockWS.instances[1]!;
    ws2.fire("open");
    ws2.fire("message", results("как дела", true)); // committed накапливается поверх сохранённого
    expect(partials.at(-1)).toBe("привет как дела"); // прошлый сегмент НЕ потерян
  });

  it("штатное закрытие (1000) НЕ реконнектит, отдаёт closeCb", () => {
    const stream = new DeepgramSttProvider("k").open({ sampleRate: 16_000 });
    let closed = false;
    stream.onClose(() => {
      closed = true;
    });
    const ws1 = MockWS.instances[0]!;
    ws1.fire("open");
    ws1.fire("close", { code: 1000 });
    vi.advanceTimersByTime(300);
    expect(MockWS.instances.length).toBe(1); // без реконнекта
    expect(closed).toBe(true);
  });

  it("после нашего close() аномальный обрыв НЕ реконнектит", () => {
    const stream = new DeepgramSttProvider("k").open({ sampleRate: 16_000 });
    const ws1 = MockWS.instances[0]!;
    ws1.fire("open");
    void stream.close(); // closed=true выставляется синхронно
    ws1.fire("close", { code: 1006 });
    vi.advanceTimersByTime(300);
    expect(MockWS.instances.length).toBe(1); // наш close() — реконнекта быть не должно
  });

  it("КОРОТКАЯ ФРАЗА: close() ДО открытия WS ждёт хендшейк, шлёт буфер и финал (речь НЕ теряется)", async () => {
    // Регресс «РЕЧЬ ПОТЕРЯНА»: VAD эндпоинтит быстрее, чем успевает хендшейк WS. Раньше close()
    // выбрасывал queue и не слал CloseStream (не open) → Deepgram получал НОЛЬ.
    const stream = new DeepgramSttProvider("k").open({ sampleRate: 16_000 });
    const finals: string[] = [];
    stream.onPartial((p) => {
      if (p.final) finals.push(p.text);
    });
    const ws = MockWS.instances[0]!;
    stream.pushAudio(new ArrayBuffer(640)); // аудио пришло ДО открытия → буферизуется
    expect(ws.sent.length).toBe(0); // WS ещё в хендшейке — ничего не ушло
    const closing = stream.close(); // VAD эндпоинтит, пока сокет не открыт
    ws.fire("open"); // сокет открылся ПОЗЖЕ — close() должен был дождаться и отправить буфер
    ws.fire("message", results("вруби мою волну", true));
    await vi.advanceTimersByTimeAsync(900); // дренаж waitForOpen + waitForFlush
    await closing;
    expect(ws.sent.some((d) => d instanceof ArrayBuffer)).toBe(true); // буфер УШЁЛ, не выброшен
    expect(ws.sent.some((d) => String(d).includes("CloseStream"))).toBe(true); // финализировали
    expect(finals.at(-1)).toBe("вруби мою волну"); // речь дошла
  });

  it("close() при мёртвом хендшейке не виснет (таймаут waitForOpen)", async () => {
    const stream = new DeepgramSttProvider("k").open({ sampleRate: 16_000 });
    stream.pushAudio(new ArrayBuffer(640));
    const closing = stream.close(); // open так и не придёт
    await vi.advanceTimersByTimeAsync(900); // 800мс waitForOpen + хвост
    await expect(closing).resolves.toBeUndefined(); // завершилось, не зависло
  });

  it("исчерпание бюджета реконнектов → closeCb (пайплайн переоткроет сам)", () => {
    const stream = new DeepgramSttProvider("k").open({ sampleRate: 16_000 });
    let closed = false;
    stream.onClose(() => {
      closed = true;
    });
    // 5 подряд обрывов без успешного open — бюджет MAX_RECONNECTS исчерпывается.
    for (let i = 0; i < 6; i += 1) {
      const ws = MockWS.instances.at(-1)!;
      ws.fire("close", { code: 1006 });
      vi.advanceTimersByTime(2500);
    }
    expect(closed).toBe(true); // сдались — отдали закрытие наверх
  });
});

describe("Deepgram ПЕРСИСТЕНТНЫЙ WS (§10, JARVIS_DEEPGRAM_PERSISTENT=1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWS.reset();
    (globalThis as { WebSocket?: unknown }).WebSocket = MockWS as unknown;
    process.env.JARVIS_DEEPGRAM_PERSISTENT = "1";
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env.JARVIS_DEEPGRAM_PERSISTENT = undefined;
  });

  // Прогнать один простой ход до финала. firstOpen=true → поднять хендшейк (первый ход).
  async function runTurn(provider: DeepgramSttProvider, word: string | null, firstOpen: boolean) {
    const t = provider.open({ sampleRate: 16_000 });
    const finals: string[] = [];
    let closed = false;
    t.onPartial((p) => {
      if (p.final) finals.push(p.text);
    });
    t.onClose(() => {
      closed = true;
    });
    const ws = MockWS.instances[0]!;
    if (firstOpen) ws.fire("open");
    if (word !== null) ws.fire("message", results(word, true));
    const closing = t.close();
    await vi.advanceTimersByTimeAsync(700);
    await closing;
    return { finals, closed, ws };
  }

  it("ОДИН сокет на 3 хода (суть фикса), финалы раздельные, onClose не звался", async () => {
    const provider = new DeepgramSttProvider("k");
    const r1 = await runTurn(provider, "привет", true);
    const r2 = await runTurn(provider, "как дела", false);
    const r3 = await runTurn(provider, "пока", false);
    expect(MockWS.instances.length).toBe(1); // ОДИН сокет на все ходы — нет churn
    expect(r1.finals).toEqual(["привет"]);
    expect(r2.finals).toEqual(["как дела"]);
    expect(r3.finals).toEqual(["пока"]);
    expect(r1.closed || r2.closed || r3.closed).toBe(false);
    expect(MockWS.instances[0]!.closeCalls).toBe(0); // сокет жив между ходами
  });

  it("close() хода = Finalize, НЕ CloseStream; сокет не закрывается", async () => {
    const provider = new DeepgramSttProvider("k");
    const r = await runTurn(provider, "тест", true);
    expect(r.ws.hasSent("Finalize")).toBe(true);
    expect(r.ws.hasSent("CloseStream")).toBe(false);
    expect(r.ws.closeCalls).toBe(0);
    expect(r.finals).toEqual(["тест"]);
  });

  it("нет склейки реплик: committed обнуляется на границе хода", async () => {
    const provider = new DeepgramSttProvider("k");
    const r1 = await runTurn(provider, "ход один", true);
    const r2 = await runTurn(provider, "ход два", false);
    expect(r1.finals).toEqual(["ход один"]);
    expect(r2.finals).toEqual(["ход два"]); // НЕ «ход один ход два»
  });

  it("поздний is_final прошлого хода после запечатывания → дроп (не протекает в новый)", async () => {
    const provider = new DeepgramSttProvider("k");
    const t1 = provider.open({ sampleRate: 16_000 });
    const finals1: string[] = [];
    t1.onPartial((p) => {
      if (p.final) finals1.push(p.text);
    });
    const ws = MockWS.instances[0]!;
    ws.fire("open");
    ws.fire("message", results("привет", true));
    const c1 = t1.close();
    await vi.advanceTimersByTimeAsync(700);
    await c1; // ход 1 запечатан (activeTurn=-1)
    ws.fire("message", results("хвост", true)); // поздний Result БЕЗ активного хода → дроп
    const t2 = provider.open({ sampleRate: 16_000 });
    const finals2: string[] = [];
    t2.onPartial((p) => {
      if (p.final) finals2.push(p.text);
    });
    ws.fire("message", results("новое", true));
    const c2 = t2.close();
    await vi.advanceTimersByTimeAsync(700);
    await c2;
    expect(finals2).toEqual(["новое"]); // «хвост» не протёк
  });

  it("reconnect ПОСРЕДИ хода: committed пересобран, без дублей; onClose не звался", async () => {
    const provider = new DeepgramSttProvider("k");
    const t = provider.open({ sampleRate: 16_000 });
    let closed = false;
    const finals: string[] = [];
    t.onClose(() => {
      closed = true;
    });
    t.onPartial((p) => {
      if (p.final) finals.push(p.text);
    });
    const ws1 = MockWS.instances[0]!;
    ws1.fire("open");
    t.pushAudio(new ArrayBuffer(640));
    ws1.fire("message", results("привет", true)); // committed=привет на старом сокете
    ws1.fire("close", { code: 1006 }); // обрыв посреди хода
    expect(closed).toBe(false); // НЕ финализируем — реконнектим
    await vi.advanceTimersByTimeAsync(300);
    expect(MockWS.instances.length).toBe(2); // подняли новый
    const ws2 = MockWS.instances[1]!;
    ws2.fire("open"); // open-handler сбрасывает committed + реплеит буфер хода
    expect(ws2.sent.some((d) => d instanceof ArrayBuffer)).toBe(true);
    ws2.fire("message", results("привет как дела", true)); // полный финал после реплея
    const closing = t.close();
    await vi.advanceTimersByTimeAsync(700);
    await closing;
    expect(finals).toEqual(["привет как дела"]); // НЕ «привет привет как дела»
  });

  // Прод 26.09 (C1): ход «слушаю» завис без аудио на 6 ч — Deepgram закрывал 1011 «did not receive audio», мы
  // переподключались, open обнулял бюджет и реплеил старый буфер → 1686 кругов в платный STT. Каждое правило — своим
  // тестом (адверс-ревью р1: один тест не падал при откате половины фикса):
  //  R1 бюджет реконнектов обнуляет только ЖИВОЕ аудио, не open;  R2 1011 при ходе вообще без звука → стоп сразу;
  //  R3 1011 при ИДУЩЕМ звуке (владелец говорит) — переподключаемся;  R4 реплей буфера = звук хода (короткая фраза
  //  целиком в буфере до open не теряется на не-таймаутном 1011).
  const cycle = async (code: number, n: number, withAudio: boolean, t: { pushAudio(b: ArrayBuffer): void }) => {
    for (let i = 0; i < n; i++) {
      const before = MockWS.instances.length;
      await vi.advanceTimersByTimeAsync(2100);
      if (MockWS.instances.length === before) break; // нового сокета нет — стрим закрыт, мёртвый не дёргаем
      const ws = MockWS.instances[MockWS.instances.length - 1]!;
      ws.fire("open");
      if (withAudio) t.pushAudio(new ArrayBuffer(640));
      ws.fire("close", { code });
    }
  };
  const watch = (t: { onClose(cb: () => void): void }) => {
    const st = { closed: false };
    t.onClose(() => (st.closed = true));
    return st;
  };

  it("R1: прод-форма шторма — 1011 «did not receive audio» при буфере от начала хода → стоп на ПЕРВОМ сокете (ревью р2)", async () => {
    const t = new DeepgramSttProvider("k").open({ sampleRate: 16_000 });
    const st = watch(t);
    MockWS.instances[0]!.fire("open");
    t.pushAudio(new ArrayBuffer(640)); // в начале хода звук был → в буфере
    MockWS.instances[0]!.fire("close", { code: 1011, reason: "did not receive audio data" });
    await cycle(1011, 20, false, t);
    expect(MockWS.instances.length).toBe(1); // на коде до фикса — 21, после ревью р1 — 6 (держал только бюджет)
    expect(st.closed).toBe(true);
  });

  it("R1: обрыв 1006 без живого звука посреди хода тоже ограничен бюджетом (open его больше не обнуляет)", async () => {
    const t = new DeepgramSttProvider("k").open({ sampleRate: 16_000 });
    const st = watch(t);
    MockWS.instances[0]!.fire("open");
    t.pushAudio(new ArrayBuffer(640));
    MockWS.instances[0]!.fire("close", { code: 1006 });
    await cycle(1006, 20, false, t);
    expect(MockWS.instances.length).toBeLessThanOrEqual(6);
    expect(st.closed).toBe(true);
  });

  it("R2: ход вообще без звука + 1011 → стоп сразу, без реконнекта", async () => {
    const t = new DeepgramSttProvider("k").open({ sampleRate: 16_000 });
    const st = watch(t);
    MockWS.instances[0]!.fire("open");
    MockWS.instances[0]!.fire("close", { code: 1011, reason: "did not receive audio data" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(MockWS.instances.length).toBe(1);
    expect(st.closed).toBe(true);
  });

  it("R3: 1011 при идущем звуке (владелец говорит) → переподключаемся, стрим НЕ закрыт; живой звук держит бюджет полным", async () => {
    const t = new DeepgramSttProvider("k").open({ sampleRate: 16_000 });
    const st = watch(t);
    MockWS.instances[0]!.fire("open");
    t.pushAudio(new ArrayBuffer(640));
    MockWS.instances[0]!.fire("close", { code: 1011, reason: "internal" });
    await cycle(1006, 8, true, t); // 8 обрывов > MAX_RECONNECTS, но после каждого open — живой звук
    expect(st.closed).toBe(false);
    expect(MockWS.instances.length).toBe(9); // 1 + 8 реконнектов, ни одного отказа по бюджету
  });

  it("R4: короткая фраза целиком в буфере ДО open, затем 1011 не по таймауту → финал не теряется", async () => {
    const t = new DeepgramSttProvider("k").open({ sampleRate: 16_000 });
    const finals: string[] = [];
    t.onPartial((p) => {
      if (p.final) finals.push(p.text);
    });
    const st = watch(t);
    t.pushAudio(new ArrayBuffer(640)); // «стоп» ушёл в буфер, сокет ещё не открыт
    const ws1 = MockWS.instances[0]!;
    ws1.fire("open"); // реплей буфера
    ws1.fire("close", { code: 1011, reason: "internal server error" });
    await vi.advanceTimersByTimeAsync(2100);
    const ws2 = MockWS.instances[1]!;
    expect(ws2).toBeDefined(); // переподключились (реплей — звук хода)
    ws2.fire("open");
    const closing = t.close();
    ws2.fire("message", results("стоп", true));
    await vi.advanceTimersByTimeAsync(700);
    await closing;
    expect(finals).toEqual(["стоп"]);
    expect(st.closed).toBe(false);
  });

  it("barge-in: beginTurn поверх незакрытого хода бросает старый (его close = no-op)", async () => {
    const provider = new DeepgramSttProvider("k");
    const t1 = provider.open({ sampleRate: 16_000 });
    const finals1: string[] = [];
    t1.onPartial((p) => {
      if (p.final) finals1.push(p.text);
    });
    const ws = MockWS.instances[0]!;
    ws.fire("open");
    ws.fire("message", results("недо", false)); // interim, БЕЗ close
    const t2 = provider.open({ sampleRate: 16_000 }); // новый ход поверх → бросает A
    const finals2: string[] = [];
    t2.onPartial((p) => {
      if (p.final) finals2.push(p.text);
    });
    ws.fire("message", results("новая фраза", true));
    const c2 = t2.close();
    await vi.advanceTimersByTimeAsync(700);
    await c2;
    const c1 = t1.close(); // close брошенного хода — no-op
    await vi.advanceTimersByTimeAsync(700);
    await c1;
    expect(finals2).toEqual(["новая фраза"]);
    expect(finals1).toEqual([]); // ход A финал НЕ выдал
    expect(MockWS.instances.length).toBe(1);
  });

  it("H14: обрыв В ПРОСТОЕ (1006 между ходами) → следующий ход СЛЫШЕН (таймлайн не стейл)", async () => {
    const provider = new DeepgramSttProvider("k");
    // Ход 1 с РЕАЛЬНЫМ аудио — набиваем sentSec > 0.05с (10 кадров по 0.1с = 1.0с таймлайна).
    const t1 = provider.open({ sampleRate: 16_000 });
    const finals1: string[] = [];
    t1.onPartial((p) => {
      if (p.final) finals1.push(p.text);
    });
    const ws1 = MockWS.instances[0]!;
    ws1.fire("open");
    for (let i = 0; i < 10; i += 1) t1.pushAudio(new ArrayBuffer(3200));
    ws1.fire("message", results("привет", true));
    const c1 = t1.close();
    // Мок не шлёт start/duration → processedSec не дотягивает до turnEndSec (1.0с аудио):
    // печать идёт по страховочному кэпу SEAL_MAX_MS (3с) — прокручиваем с запасом.
    await vi.advanceTimersByTimeAsync(3200);
    await c1;
    expect(finals1).toEqual(["привет"]);

    // Сеть моргнула МЕЖДУ ходами → reconnect поднимает новый сокет при activeTurn=-1.
    ws1.fire("close", { code: 1006 });
    await vi.advanceTimersByTimeAsync(300);
    expect(MockWS.instances.length).toBe(2);
    const ws2 = MockWS.instances[1]!;
    ws2.fire("open"); // раньше: sentSec НЕ сбрасывался → turnStartSec следующего хода = 1.0с (стейл)

    // Следующий ход: Results нового сокета идут со start≈0 — не должны дропаться гейтом границы хода.
    const t2 = provider.open({ sampleRate: 16_000 });
    const finals2: string[] = [];
    t2.onPartial((p) => {
      if (p.final) finals2.push(p.text);
    });
    ws2.fire("message", results("как дела", true));
    const c2 = t2.close();
    await vi.advanceTimersByTimeAsync(700);
    await c2;
    expect(finals2).toEqual(["как дела"]); // раньше: [""] — «РЕЧЬ ПОТЕРЯНА» на каждом ходе
  });

  it("dispose() закрывает сокет и глушит reconnect", async () => {
    const provider = new DeepgramSttProvider("k");
    const t = provider.open({ sampleRate: 16_000 });
    const ws = MockWS.instances[0]!;
    ws.fire("open");
    void t;
    provider.dispose();
    expect(ws.closeCalls).toBe(1);
    ws.fire("close", { code: 1006 }); // после dispose НЕ реконнектим
    await vi.advanceTimersByTimeAsync(300);
    expect(MockWS.instances.length).toBe(1);
  });
});

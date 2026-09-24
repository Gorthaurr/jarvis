/**
 * Регресс §20: очередь озвучки фоновых итогов не должна ЗАСТРЕВАТЬ после barge-in/возврата
 * в idle (баг ревью), а явный «стоп»/«отмени» должен её ОЧИЩАТЬ (не озвучивать стейл).
 */
import { describe, expect, it } from "vitest";
import type {
  ISttProvider,
  ITtsProvider,
  SttPartial,
  SttStream,
  TtsChunk,
  TtsStream,
} from "../integrations/voice-providers.js";
import { VoicePipeline } from "./pipeline.js";

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
  private _cancelled = false;
  onChunk(cb: (c: TtsChunk) => void) { this.chunkCb = cb; }
  onError() {}
  onDone(cb: () => void) { this.doneCb = cb; }
  cancel() { this._cancelled = true; }
  get cancelled() { return this._cancelled; }
}
class CtrlTtsProvider implements ITtsProvider {
  readonly live = false;
  texts: string[] = [];
  synthesize(text: string): TtsStream { this.texts.push(text); return new CtrlTtsStream(); }
}

function make(onUserTurn: () => Promise<{ voice: string }>) {
  const stt = new CtrlSttProvider();
  const tts = new CtrlTtsProvider();
  const pipe = new VoicePipeline({ stt, tts, onUserTurn, sendSpeakChunk: () => {}, sendClientState: () => {}, followupMs: 50 });
  return { stt, tts, pipe };
}

/** Пайплайн с управляемым флагом «пользователь занят» (§9). Свежий = idle → дренаж сразу. */
function makeBusy(busy: { value: boolean }) {
  const tts = new CtrlTtsProvider();
  const pipe = new VoicePipeline({
    stt: new CtrlSttProvider(), tts,
    onUserTurn: async () => ({ voice: "" }),
    sendSpeakChunk: () => {}, sendClientState: () => {}, followupMs: 50,
    isUserBusy: () => busy.value,
  });
  return { tts, pipe };
}

describe("очередь озвучки фоновых итогов (§20)", () => {
  it("НЕ застревает: проливается при возврате в idle после barge-in на thinking", async () => {
    const turn: { resolve?: (r: { voice: string }) => void } = {};
    const { stt, tts, pipe } = make(() => new Promise((res) => { turn.resolve = res; }));

    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();
    expect(pipe.state).toBe("thinking");

    pipe.speakQueued("Готово, нашёл 5 машин."); // в thinking — в очередь, не озвучивается
    expect(tts.texts).not.toContain("Готово, нашёл 5 машин.");

    pipe.onVadEvent("barge_in"); // перебил на thinking
    turn.resolve?.({ voice: "Поздний ответ." }); // отброшен (gen mismatch)
    await flush();

    pipe.mute(); // канал освободился → idle
    await flush();

    // Инвариант теста — очередь ПРОЛИЛАСЬ, а не застряла. Кто первый — определяет порядок выдачи:
    // с 2026-09-02 несрочные идут СВЕЖИЙ ВПЕРЁД (см. отдельный тест ниже), поэтому здесь звучит
    // спасённая реплика хода, а фоновой итог остаётся в очереди и уйдёт следующим.
    expect(tts.texts.length).toBeGreaterThan(0);
    expect(tts.texts).toContain("Поздний ответ.");
  });

  /**
   * 🔴 Лог 2026-09-02: шторм из шести задач, девять реплик потеряно за десять минут. При FIFO первым
   * произносится самый СТАРЫЙ итог — и пока он звучит, свежие протухают по TTL: владелец слышит
   * ответ на вопрос, о котором уже забыл, и НЕ слышит ответ на заданный только что.
   */
  it("несрочные итоги произносятся СВЕЖИЙ ВПЕРЁД (старый протухнет, а не наоборот)", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush(); // канал занят раздумьем → обе реплики лягут в очередь
    const realNow = Date.now;
    try {
      pipe.speakQueued("Старый итог.");
      Date.now = () => realNow() + 30_000; // свежий пришёл на полминуты позже
      pipe.speakQueued("Свежий итог.");
      pipe.mute(); // канал освободился → дренаж
      await flush();
      expect(tts.texts[0]).toBe("Свежий итог.");
    } finally {
      Date.now = realNow;
    }
  });

  it("СРОЧНОЕ обгоняет всё независимо от возраста (напоминание важнее свежего итога)", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();
    const realNow = Date.now;
    try {
      pipe.speakQueued("Срочное напоминание.", true);
      Date.now = () => realNow() + 30_000;
      pipe.speakQueued("Свежий итог.");
      pipe.mute();
      await flush();
      expect(tts.texts[0]).toBe("Срочное напоминание.");
    } finally {
      Date.now = realNow;
    }
  });

  it("явный «стоп»/«отмени» (clearPendingSpeech) очищает очередь — стейл НЕ озвучивается", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();
    pipe.speakQueued("Стейл-итог.");
    pipe.clearPendingSpeech(); // роутер зовёт это на «стоп»/«отмени»
    pipe.mute();
    await flush();
    expect(tts.texts).not.toContain("Стейл-итог.");
  });
});

// 🔴 Живая жалоба 2026-07-24: «договаривает уже спустя минуты 2 сразу всё скопом». Очередь фоновых
// итогов не имела ни срока годности, ни капа — накопленное вываливалось пачкой, причём протухшие
// реплики звучали как свежие (владелец слышит ответ на вопрос, о котором давно забыл).
describe("очередь озвучки: срок годности и кап (анти-«скопом через минуты»)", () => {
  it("протухший НЕсрочный итог не произносится (текст ход уже отдал в чат)", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();
    expect(pipe.state).toBe("thinking"); // канал занят → итог ляжет в очередь

    pipe.speakQueued("Итог, который протух.");
    // Пролежал дольше JARVIS_SPEECH_QUEUE_TTL_MS (деф 120с) — двигаем часы вперёд.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 3 * 60_000;
      pipe.mute(); // канал освободился → дренаж
      await flush();
      expect(tts.texts).not.toContain("Итог, который протух.");
    } finally {
      Date.now = realNow;
    }
  });

  it("СРОЧНОЕ (напоминание) не протухает никогда — прозвучит и через час", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();

    pipe.speakQueued("Напоминание: выпить таблетки.", true); // urgent
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 60 * 60_000;
      pipe.mute();
      await flush();
      expect(tts.texts).toContain("Напоминание: выпить таблетки.");
    } finally {
      Date.now = realNow;
    }
  });

  it("кап очереди: десяток накопленных итогов не превращается в пачку — старые вытесняются", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();

    for (let i = 1; i <= 8; i += 1) pipe.speakQueued(`Итог номер ${i}.`);
    pipe.mute();
    await flush();
    // Самые старые вытеснены капом (деф 4); свежий — на месте.
    expect(tts.texts).not.toContain("Итог номер 1.");
    expect(tts.texts.length).toBeLessThanOrEqual(4);
  });

  // КОНТРОЛЬ-7 ВОЛНЫ D (корневой фикс класса потерь): очередь ОДНА на все проактивные источники
  // (напоминания + наблюдения + ambient). Каждый «отдавал» реплику и СРАЗУ помечал её доставленной в
  // своём durable-сторе, а очередь в этот момент могла её выбросить — после ночи офлайна восемь реплик
  // в четыре слота давали одну прозвучавшую и три потерянных НАВСЕГДА (текстовой копии у них нет).
  it("повторяемая реплика при полной очереди НЕ принимается (источник повторит), ничего не выбрасывая", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();

    const accepted: boolean[] = [];
    for (let i = 1; i <= 8; i += 1) {
      accepted.push(pipe.speakQueued(`Напоминание ${i}.`, true, { retriable: true }));
    }
    // Часть принята, остальным ЧЕСТНО отказано — вместо тихого вытеснения уже «доставленных».
    expect(accepted.filter(Boolean).length).toBeGreaterThan(0);
    expect(accepted).toContain(false);
    pipe.mute();
    await flush();
    // Главное: САМАЯ СТАРАЯ принятая реплика не вытеснена (раньше её выбрасывали, хотя источник уже
    // пометил её доставленной) — звучит именно она, а лишним честно отказано на входе.
    expect(tts.texts).toContain("Напоминание 1.");
  });

  it("НЕповторяемый итог задачи вытесняет старое НЕповторяемое (свежее важнее протухшего)", () => {
    const { stt, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    for (let i = 1; i <= 8; i += 1) expect(pipe.speakQueued(`Итог ${i}.`)).toBe(true); // всегда принимается
  });

  // КОНТРОЛЬ-8: щель в собственном фиксе — НЕповторяемая ветка вытесняла из очереди уже ПРИНЯТУЮ
  // retriable-реплику, которую источник уже пометил доставленной (`done`). Терялось напоминание.
  // КОНТРОЛЬ-11 (MEDIUM): исход сообщался ДО синтеза — отказ TTS (сеть/квота) навсегда помечал
  // напоминание доставленным, хотя не прозвучало ни звука, а лог рапортовал «озвучено».
  it("синтез начался, но звука ещё НЕ было → «доставлено» не заявляем", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();
    const outcomes: boolean[] = [];
    pipe.speakQueued("Напоминание: выпить таблетки.", true, {
      retriable: true,
      onOutcome: (spoken) => outcomes.push(spoken),
    });
    pipe.mute(); // освобождает канал → реплика уходит в синтез
    await flush();
    expect(tts.texts).toContain("Напоминание: выпить таблетки."); // синтез ЗАПУЩЕН
    // ...но ни одного байта клиенту не ушло (мок-стрим молчит) — значит «прозвучало» заявлять НЕЛЬЗЯ.
    // Раньше исход слался ДО синтеза, и отказ TTS (сеть/квота) навсегда терял напоминание.
    expect(outcomes).toEqual([]);
  });

  it("итог задачи НЕ выбрасывает из очереди принятое напоминание — отказывают ЕМУ", () => {
    const { stt, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    // Очередь занята принятыми durable-репликами (напоминания/наблюдения).
    for (let i = 1; i <= 4; i += 1) {
      expect(pipe.speakQueued(`Напоминание ${i}.`, true, { retriable: true })).toBe(true);
    }
    // Итог задачи не имеет права выкинуть ни одну из них: у него есть текстовая копия, у них — нет.
    expect(pipe.speakQueued("Готово, сэр.")).toBe(false);
  });
});

// Ревью фиксов речи 2026-07-24: fail-safe (сохранение отменённой реплики) не должен воскрешать то,
// что владелец ЗАПРЕТИЛ, и не должен переозвучивать уже услышанное.
describe("fail-safe отменённой реплики — границы (ревью)", () => {
  it("CRITICAL: после «заткнись» отменённая реплика НЕ всплывает из очереди", async () => {
    const turn: { resolve?: (r: { voice: string }) => void } = {};
    const { stt, tts, pipe } = make(() => new Promise((res) => { turn.resolve = res; }));
    pipe.onWake();
    stt.last!.emit({ text: "какая погода", final: true });
    await flush();
    expect(pipe.state).toBe("thinking");

    // Владелец: «заткнись» → роутер зовёт stop-путь + чистку очереди.
    pipe.onVadEvent("barge_in");
    pipe.clearPendingSpeech();
    turn.resolve?.({ voice: "Сегодня пасмурно, плюс восемь." }); // ход договорил ПОСЛЕ запрета
    await flush();
    pipe.mute(); // канал свободен — если бы реплика попала в очередь, она бы прозвучала
    await flush();

    expect(tts.texts).not.toContain("Сегодня пасмурно, плюс восемь.");
  });

  it("перебивание в РАЗДУМЬЕ (речь ещё не пошла) → реплика сохраняется и звучит позже", async () => {
    const turn: { resolve?: (r: { voice: string }) => void } = {};
    const { stt, tts, pipe } = make(() => new Promise((res) => { turn.resolve = res; }));
    pipe.onWake();
    stt.last!.emit({ text: "какая погода", final: true });
    await flush();

    pipe.onVadEvent("barge_in"); // перебил, но НЕ просил молчать
    turn.resolve?.({ voice: "Сегодня пасмурно, плюс восемь." });
    await flush();
    pipe.mute();
    await flush();

    expect(tts.texts).toContain("Сегодня пасмурно, плюс восемь."); // работа не пропала
  });
});

describe("§9 уважительная проактивность — не мешать занятому пользователю", () => {
  it("занят (звонок/полный экран) → НЕсрочный фоновый итог ДЕРЖИТСЯ, не озвучивается", () => {
    const { tts, pipe } = makeBusy({ value: true });
    pipe.speakQueued("Готово, нашёл пять машин."); // несрочное
    expect(tts.texts).not.toContain("Готово, нашёл пять машин.");
  });

  it("занят → СРОЧНОЕ напоминание (будильник) озвучивается ВСЁ РАВНО", () => {
    const { tts, pipe } = makeBusy({ value: true });
    pipe.speakQueued("Пора в зал, сэр.", true); // urgent
    expect(tts.texts).toContain("Пора в зал, сэр.");
  });

  it("освободился (drainPending) → отложенный несрочный итог отдаётся", () => {
    const busy = { value: true };
    const { tts, pipe } = makeBusy(busy);
    pipe.speakQueued("Готово, нашёл пять машин.");
    expect(tts.texts).not.toContain("Готово, нашёл пять машин."); // держится, пока занят
    busy.value = false; // вышел из звонка/полноэкранки
    pipe.drainPending();
    expect(tts.texts).toContain("Готово, нашёл пять машин."); // отдан по освобождении
  });
});

/**
 * 🔴 Лог 2026-09-02: за день 21 реплика не прозвучала (9 — за десять минут, пока параллельно шли
 * шесть задач). Само отбрасывание правильное (протухший итог произносить вредно, очередь конечна),
 * но потеря была МОЛЧАЛИВОЙ: «текст ход уже отдал в чат» — а владелец в полноэкранной игре чата не
 * видит, для него Джарвис просто промолчал. Отсюда его «я не слышу, что ты говоришь».
 */
describe("потерянные итоги названы вслух, а не проглочены", () => {
  it("после протухания следующая реплика начинается с честного предупреждения", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "долгая задача", final: true });
    await flush();
    pipe.speakQueued("Итог, который протух.");
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 3 * 60_000;
      pipe.mute();
      await flush();
      expect(tts.texts.join(" ")).not.toContain("который протух");
      // Следующий итог доходит — и несёт признание о непроговорённом.
      pipe.speakQueued("Свежий итог.");
      await flush();
      const said = tts.texts.join(" ");
      expect(said).toContain("Свежий итог.");
      expect(said).toMatch(/не успел проговорить/);
    } finally {
      Date.now = realNow;
    }
  });

  it("без потерь предупреждения нет (не мантра)", async () => {
    const { stt, tts, pipe } = make(() => new Promise(() => {}));
    pipe.onWake();
    stt.last!.emit({ text: "задача", final: true });
    await flush();
    pipe.mute();
    pipe.speakQueued("Обычный итог.");
    await flush();
    expect(tts.texts.join(" ")).not.toMatch(/не успел проговорить/);
  });
});

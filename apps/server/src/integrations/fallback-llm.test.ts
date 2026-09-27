// Волна G: резерв мозга на подписке — переключение каналов и ЧЕСТНОСТЬ исходов.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicLlmProvider, _resetApiFailureForTest, _setApiFailureForTest } from "./anthropic.js";
import { FallbackLlmProvider } from "./fallback-llm.js";
import { type SdkModule, SubscriptionLlmProvider, _resetSubscriptionFailureForTest, _setSubscriptionFailureForTest } from "./subscription-llm.js";
import type { ILlmProvider, LlmDelta, LlmRequest, LlmResponse } from "./llm.js";

const REQ: LlmRequest = { tier: "sonnet", model: "claude-sonnet-4-6", systemStatic: "персона", messages: [{ role: "user", content: "привет" }] };

function resp(over: Partial<LlmResponse> = {}): LlmResponse {
  return {
    text: "ответ",
    toolUses: [],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stubbed: false,
    ...over,
  };
}

/** Провайдер-заглушка с управляемым поведением. */
function fake(opts: { live: boolean; result?: LlmResponse; throws?: Error; text?: string }): ILlmProvider & { calls: number } {
  const p = {
    live: opts.live,
    calls: 0,
    async complete(): Promise<LlmResponse> {
      p.calls += 1;
      if (opts.throws) throw opts.throws;
      return opts.result ?? resp();
    },
    async completeStream(_r: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
      p.calls += 1;
      if (opts.throws) throw opts.throws;
      const r = opts.result ?? resp();
      if (r.text && !r.stubbed) onDelta({ text: r.text }); // как реальный провайдер: стаб дельтой не отдаётся (W0)
      return r;
    },
  };
  return p;
}

const STUB = resp({ text: "Связь прервалась, сэр.", stopReason: "stub", stubbed: true });

describe("FallbackLlmProvider (волна G)", () => {
  it("основной канал работает → резерв не трогаем", async () => {
    const primary = fake({ live: true, result: resp({ text: "по API" }) });
    const secondary = fake({ live: true });
    const p = new FallbackLlmProvider(primary, secondary);
    const r = await p.complete(REQ);
    expect(r.text).toBe("по API");
    expect(secondary.calls).toBe(0);
    expect(p.lastChannel).toBe("primary");
  });

  it("основной вернул СТАБ (кредит кончился) → ход уходит на подписку", async () => {
    const primary = fake({ live: true, result: STUB });
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const onFallback = vi.fn();
    const p = new FallbackLlmProvider(primary, secondary, { onFallback });
    const r = await p.complete(REQ);
    expect(r.text).toBe("по подписке");
    expect(r.stubbed).toBe(false); // ход РЕАЛЬНО выполнен — петля не должна считать его провалом
    expect(p.lastChannel).toBe("subscription");
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("нет ключа API вовсе (primary мёртв) → сразу подписка, основной не зовём", async () => {
    const primary = fake({ live: false, result: STUB });
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const r = await new FallbackLlmProvider(primary, secondary).complete(REQ);
    expect(r.text).toBe("по подписке");
    expect(primary.calls).toBe(0);
  });

  it("резерв НЕ настроен → честный стаб основного (никаких обещаний несуществующего канала)", async () => {
    const primary = fake({ live: true, result: STUB });
    const secondary = fake({ live: false });
    const r = await new FallbackLlmProvider(primary, secondary).complete(REQ);
    expect(r.stubbed).toBe(true);
    expect(r.stopReason).toBe("stub"); // H2: петля обязана увидеть провал хода
    expect(secondary.calls).toBe(0);
  });

  it("резерв УПАЛ (протухший токен/лимит подписки) → стаб, а не выдуманный успех", async () => {
    const primary = fake({ live: true, result: STUB });
    const secondary = fake({ live: true, throws: new Error("подписка: OAuth session expired") });
    const r = await new FallbackLlmProvider(primary, secondary).complete(REQ);
    expect(r.stubbed).toBe(true);
    expect(r.stopReason).toBe("stub");
  });

  it("оба канала мертвы → стаб (поведение как до волны G)", async () => {
    const primary = fake({ live: false, result: STUB });
    const secondary = fake({ live: false });
    const p = new FallbackLlmProvider(primary, secondary);
    expect(p.live).toBe(false);
    expect((await p.complete(REQ)).stubbed).toBe(true);
  });

  it("JARVIS_FORCE_SUBSCRIPTION=1 → сразу подписка, основной канал не трогаем (проверка резерва)", async () => {
    process.env.JARVIS_FORCE_SUBSCRIPTION = "1";
    try {
      const primary = fake({ live: true, result: resp({ text: "по API" }) });
      const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
      const r = await new FallbackLlmProvider(primary, secondary).complete(REQ);
      expect(r.text).toBe("по подписке");
      expect(primary.calls).toBe(0);
    } finally {
      delete process.env.JARVIS_FORCE_SUBSCRIPTION;
    }
  });

  // СКОРОСТЬ: при исчерпанном кредите каждый ход тратил секунды на обречённый запрос к API.
  it("предохранитель: после 2 отказов подряд основной канал не дёргаем, идём сразу в резерв", async () => {
    const primary = fake({ live: true, result: STUB });
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary);
    await p.complete(REQ);
    await p.complete(REQ);
    expect(primary.calls).toBe(2);
    await p.complete(REQ); // третий ход — основной уже на паузе
    await p.complete(REQ);
    expect(primary.calls).toBe(2); // лишних попыток нет — время не тратится
    expect(p.lastChannel).toBe("subscription");
  });

  it("предохранитель ПОЛУОТКРЫТЫЙ: после паузы основной пробуется снова (баланс пополнили)", async () => {
    let clock = 0;
    const primary = fake({ live: true, result: STUB });
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary, {}, () => clock);
    await p.complete(REQ);
    await p.complete(REQ); // сработал предохранитель
    clock += 400_000; // пауза (деф 5 мин) истекла
    await p.complete(REQ);
    expect(primary.calls).toBe(3); // снова попробовали — восстановление без перезапуска
  });

  it("успех основного снимает предохранитель (не залипаем в резерве)", async () => {
    const primary = fake({ live: true, result: STUB });
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary);
    await p.complete(REQ);
    // Основной «ожил»: следующий вызов вернёт нормальный ответ.
    (primary as unknown as { complete: () => Promise<LlmResponse> }).complete = async () => resp({ text: "по API" });
    const r = await p.complete(REQ);
    expect(r.text).toBe("по API");
    expect(p.lastChannel).toBe("primary");
  });

  it("live = true, если жив ХОТЬ ОДИН канал", () => {
    expect(new FallbackLlmProvider(fake({ live: false }), fake({ live: true })).live).toBe(true);
    expect(new FallbackLlmProvider(fake({ live: true }), fake({ live: false })).live).toBe(true);
  });

  // 🔴 Стрим + фолбэк: нельзя «отыграть» уже озвученные дельты — иначе владелец услышит два ответа.
  it("стрим: дельты основного НЕ уходят наружу, пока ход не признан успешным", async () => {
    const primary = fake({ live: true, result: STUB }); // стаб → значит его дельты озвучивать нельзя
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const deltas: string[] = [];
    const r = await new FallbackLlmProvider(primary, secondary).completeStream(REQ, (d) => deltas.push(d.text));
    expect(r.text).toBe("по подписке");
    expect(deltas.join("")).toBe("по подписке"); // ровно один ответ, без текста стаба
  });

  it("стрим: успешный основной канал отдаёт свой текст ровно один раз", async () => {
    const primary = fake({ live: true, result: resp({ text: "по API" }) });
    const deltas: string[] = [];
    const r = await new FallbackLlmProvider(primary, fake({ live: true })).completeStream(REQ, (d) => deltas.push(d.text));
    expect(deltas.join("")).toBe("по API");
    expect(r.text).toBe("по API");
  });
});

/**
 * 🔴 Живая проверка 2026-09-01: кредиты API исчерпаны И OAuth-сессия подписки протухла — оба канала
 * мертвы. Владелец слышал «связь прервалась» и повторял фразу, не зная, что нужно переавторизоваться:
 * система знала причину и молчала.
 */
describe("оба канала легли — владельцу называют ПРИЧИНУ, а не «связь прервалась»", () => {
  const req = { tier: "sonnet", model: "m", systemStatic: "s", systemDynamic: "d", messages: [{ role: "user" as const, content: "привет" }] };

  it("протухшая авторизация подписки → сказано, что делать", async () => {
    _resetSubscriptionFailureForTest();
    const primary = { live: true, complete: async () => ({ text: "Связь с сервером прервалась, сэр. Повторите, пожалуйста.", toolUses: [], stopReason: "stub" as const, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, stubbed: true }), completeStream: async () => { throw new Error("не нужен"); } };
    const secondary = { live: true, complete: async () => { throw new Error("подписка: подписка не авторизована (сессия истекла)"); }, completeStream: async () => { throw new Error("подписка: подписка не авторизована (сессия истекла)"); } };
    _setSubscriptionFailureForTest("Failed to authenticate: OAuth session expired"); // как это делает провайдер
    const p = new FallbackLlmProvider(primary as never, secondary as never);
    const r = await p.complete(req as never);
    expect(r.stubbed).toBe(true); // ход всё равно провален — петля обязана это видеть
    expect(r.text).toMatch(/setup-token/); // владельцу сказано, ЧТО сделать
    expect(r.text).not.toMatch(/Связь с сервером прервалась/); // бесполезная общая фраза ушла
  });

  it("исчерпанные кредиты и лимит — своя формулировка (лечение другое)", async () => {
    _resetSubscriptionFailureForTest();
    _setSubscriptionFailureForTest("You're out of usage credits");
    const primary = { live: true, complete: async () => ({ text: "Связь с сервером прервалась, сэр.", toolUses: [], stopReason: "stub" as const, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, stubbed: true }), completeStream: async () => { throw new Error("не нужен"); } };
    const secondary = { live: true, complete: async () => { throw new Error("подписка: лимит исчерпан"); }, completeStream: async () => { throw new Error("подписка: лимит исчерпан"); } };
    const r = await new FallbackLlmProvider(primary as never, secondary as never).complete(req as never);
    expect(r.text).toMatch(/исчерпан/);
  });

  it("причина неизвестна → прежняя общая фраза (не выдумываем диагноз)", async () => {
    _resetSubscriptionFailureForTest();
    const primary = { live: true, complete: async () => ({ text: "Связь с сервером прервалась, сэр.", toolUses: [], stopReason: "stub" as const, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, stubbed: true }), completeStream: async () => { throw new Error("не нужен"); } };
    const secondary = { live: true, complete: async () => { throw new Error("что-то пошло не так"); }, completeStream: async () => { throw new Error("что-то пошло не так"); } };
    const r = await new FallbackLlmProvider(primary as never, secondary as never).complete(req as never);
    expect(r.text).toMatch(/Связь с сервером прервалась/);
  });
});

/**
 * 🔴 «Правильно вырубать API, а не долбить его всё время» (владелец, 2026-09-02, по разбору логов:
 * 15 заведомо мёртвых вызовов за день + 101 строка «переключаюсь на резерв»). Отказ, который повтором
 * НЕ лечится (кончился баланс / ключ не принят), обязан ВЫКЛЮЧАТЬ канал, а не ставить его на паузу.
 * Каждый тест здесь падает, если снять фикс (проверено ревертом).
 */
describe("терминальный отказ основного канала — выключаем, а не долбим", () => {
  /** Провайдер, который ведёт себя как настоящий: перед возвратом стаба ЗАПИСЫВАЕТ причину отказа. */
  function primaryWithFailure(text: string, status?: number): ILlmProvider & { calls: number } {
    const p = {
      live: true,
      calls: 0,
      async complete(): Promise<LlmResponse> {
        p.calls += 1;
        _setApiFailureForTest(text, status);
        return STUB;
      },
      async completeStream(): Promise<LlmResponse> {
        p.calls += 1;
        _setApiFailureForTest(text, status);
        return STUB;
      },
    };
    return p;
  }

  beforeEach(() => {
    _resetApiFailureForTest();
    delete process.env.JARVIS_PRIMARY_LLM;
    delete process.env.JARVIS_PRIMARY_RECHECK_MS;
  });
  afterEach(() => {
    _resetApiFailureForTest();
    delete process.env.JARVIS_PRIMARY_LLM;
    delete process.env.JARVIS_PRIMARY_RECHECK_MS;
  });

  const CREDITS = "400 {\"error\":{\"message\":\"Your credit balance is too low to access the Anthropic API\"}}";

  it("кончился баланс → канал выключен с ПЕРВОГО отказа, больше ни одного запроса", async () => {
    const primary = primaryWithFailure(CREDITS);
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary);
    for (let i = 0; i < 5; i++) await p.complete(REQ);
    expect(primary.calls).toBe(1); // до фикса: 2 (порог предохранителя) и дальше пробы после паузы
    expect(p.lastChannel).toBe("subscription");
  });

  it("пауза транзиентного предохранителя выключенный канал НЕ воскрешает", async () => {
    let clock = 0;
    const primary = primaryWithFailure(CREDITS);
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary, {}, () => clock);
    await p.complete(REQ);
    clock += 400_000; // прежняя 5-минутная пауза истекла бы
    await p.complete(REQ);
    clock += 400_000;
    await p.complete(REQ);
    expect(primary.calls).toBe(1); // до фикса: 3 — ровно то «долбление», на которое жаловался владелец
  });

  it("редкая перепроверка настаёт → канал пробуется снова (пополненный баланс подхватится сам)", async () => {
    let clock = 0;
    const primary = primaryWithFailure(CREDITS);
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary, {}, () => clock);
    await p.complete(REQ);
    clock += 6 * 3_600_000 + 1_000; // деф 6 часов
    await p.complete(REQ);
    expect(primary.calls).toBe(2); // канал не «умер навсегда» — самолечение без перезапуска
  });

  it("JARVIS_PRIMARY_RECHECK_MS=0 → не перепроверяем вовсе (до перезапуска)", async () => {
    process.env.JARVIS_PRIMARY_RECHECK_MS = "0";
    let clock = 0;
    const primary = primaryWithFailure(CREDITS);
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary, {}, () => clock);
    await p.complete(REQ);
    clock += 24 * 3_600_000;
    await p.complete(REQ);
    expect(primary.calls).toBe(1);
  });

  it("ТРАНЗИЕНТНЫЙ отказ (429) канал НЕ выключает — прежний предохранитель на 5 минут", async () => {
    let clock = 0;
    const primary = primaryWithFailure("429 rate limit exceeded", 429);
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary, {}, () => clock);
    await p.complete(REQ);
    await p.complete(REQ); // порог предохранителя
    clock += 400_000;
    await p.complete(REQ); // полуоткрытая проба обязана состояться
    expect(primary.calls).toBe(3);
  });

  it("ПРОТУХШАЯ причина прошлого сбоя живой канал не выключает", async () => {
    let clock = 0;
    // Причина записана 5 минут назад (ещё не протухла по TTL), но НЕ этим вызовом: стаб пришёл по
    // другой причине (сеть). Выключать канал по чужой улике нельзя.
    _setApiFailureForTest(CREDITS, 400, Date.now() - 300_000);
    const primary = fake({ live: true, result: STUB });
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary, {}, () => clock);
    await p.complete(REQ);
    await p.complete(REQ);
    clock += 400_000;
    await p.complete(REQ);
    expect(primary.calls).toBe(3); // транзиентный путь, а не терминальный латч
  });

  it("резерва НЕТ → канал не выключаем (иначе терять и работу, и свежую причину)", async () => {
    const primary = primaryWithFailure(CREDITS);
    const secondary = fake({ live: false });
    const p = new FallbackLlmProvider(primary, secondary);
    await p.complete(REQ);
    await p.complete(REQ);
    await p.complete(REQ);
    expect(primary.calls).toBe(3); // без резерва выключать не в пользу чего
  });

  it("JARVIS_PRIMARY_LLM=0 → ни одного запроса к API, сразу подписка", async () => {
    process.env.JARVIS_PRIMARY_LLM = "0";
    const primary = fake({ live: true, result: resp({ text: "по API" }) });
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const r = await new FallbackLlmProvider(primary, secondary).complete(REQ);
    expect(r.text).toBe("по подписке");
    expect(primary.calls).toBe(0);
  });

  it("channelStatus: паспорт видит выключённый канал и причину", async () => {
    const primary = primaryWithFailure(CREDITS);
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary);
    expect(p.channelStatus()).toEqual({ primary: "ok", subscriptionLive: true });
    await p.complete(REQ);
    const st = p.channelStatus();
    expect(st.primary).toBe("off");
    expect(st.kind).toBe("credits");
    expect(st.human).toMatch(/баланс/);
    expect(st.subscriptionLive).toBe(true);
  });

  it("основной ожил на перепроверке → латч снят, работаем по API", async () => {
    let clock = 0;
    const primary = primaryWithFailure(CREDITS);
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary, {}, () => clock);
    await p.complete(REQ);
    expect(p.channelStatus().primary).toBe("off");
    clock += 6 * 3_600_000 + 1_000;
    (primary as unknown as { complete: () => Promise<LlmResponse> }).complete = async () => resp({ text: "по API" });
    const r = await p.complete(REQ);
    expect(r.text).toBe("по API");
    expect(p.channelStatus().primary).toBe("ok");
  });

  /**
   * 🔴 C3 (аудит прод-логов 27.09): 403 «Request not allowed» на входе в Windows — это VPN, который ещё не
   * поднялся, а не ключ. Прежде он латчил канал на 6 часов как «ключ не принят»; теперь — транзиентный
   * предохранитель (для гео-блока пауза не короче 30 минут, primary-cooldown.ts) и канал в паспорте не «выключен».
   */
  const REGION_403 = '403 {"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}';

  it("403 гео-блока (VPN) канал НЕ выключает латчем — транзиентный путь с полуоткрытой пробой", async () => {
    let clock = 0;
    const primary = primaryWithFailure(REGION_403, 403);
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary, {}, () => clock);
    await p.complete(REQ);
    expect(p.channelStatus().primary).toBe("ok"); // до фикса: off / auth / «ключ не принят»
    await p.complete(REQ); // порог транзиентного предохранителя
    clock += 30 * 60_000; // пауза гео-блока (30 мин, не латч на 6 ч) истекла — канал обязан попробоваться снова
    await p.complete(REQ);
    expect(primary.calls).toBe(3); // до фикса: 1 — канал выключен на 6 часов
  });

  /**
   * 🔴 Адверс-ревью правки (2026-09-02): «выключенный» канал всё равно получал HTTP-запрос — стаб
   * добывался вызовом `primary.complete(req)`. Пока резерв отвечал, это было не видно; стоило ему
   * упасть — и на КАЖДОМ ходе уходил обречённый запрос в API, ровно то, что латч должен был убрать.
   */
  it("латч + УПАВШИЙ резерв: обречённых запросов к API больше нет", async () => {
    const primary = primaryWithFailure(CREDITS);
    const secondary: ILlmProvider = {
      live: true,
      complete: async () => {
        throw new Error("подписка: лимит исчерпан");
      },
      completeStream: async () => {
        throw new Error("подписка: лимит исчерпан");
      },
    };
    const p = new FallbackLlmProvider(primary, secondary);
    for (let i = 0; i < 5; i++) await p.complete(REQ);
    expect(primary.calls).toBe(1); // до фикса: 5 — по одному живому HTTP на каждый ход
    expect(p.channelStatus().primary).toBe("off");
  });

  /**
   * 🔴 Там же: при `JARVIS_PRIMARY_LLM=0` и отсутствующем резерве путь стаба звал API — и его
   * НАСТОЯЩИЙ ответ уходил владельцу (`stubbed:false`), хотя лог писал «стаб». Выключатель, который
   * ничего не выключает, хуже отсутствующего.
   */
  it("JARVIS_PRIMARY_LLM=0 без резерва: API не зовём вовсе, отдаём честный стаб", async () => {
    process.env.JARVIS_PRIMARY_LLM = "0";
    const primary = fake({ live: true, result: resp({ text: "РЕАЛЬНЫЙ ОТВЕТ ПО API" }) });
    const secondary = fake({ live: false });
    const r = await new FallbackLlmProvider(primary, secondary).complete(REQ);
    expect(primary.calls).toBe(0);
    expect(r.stubbed).toBe(true);
    expect(r.text).not.toBe("РЕАЛЬНЫЙ ОТВЕТ ПО API");
  });

  it("JARVIS_FORCE_SUBSCRIPTION=1: паспорт не говорит «канал ok», и API не трогаем при падении резерва", async () => {
    process.env.JARVIS_FORCE_SUBSCRIPTION = "1";
    try {
      const primary = fake({ live: true, result: resp({ text: "по API" }) });
      const secondary: ILlmProvider = {
        live: true,
        complete: async () => {
          throw new Error("подписка: лимит исчерпан");
        },
        completeStream: async () => {
          throw new Error("подписка: лимит исчерпан");
        },
      };
      const p = new FallbackLlmProvider(primary, secondary);
      const r = await p.complete(REQ);
      expect(primary.calls).toBe(0); // флаг обещает «минуя API» — обещание должно быть правдой
      expect(r.stubbed).toBe(true);
      const st = p.channelStatus();
      expect(st.primary).toBe("off");
      expect(st.kind).toBe("forced");
    } finally {
      delete process.env.JARVIS_FORCE_SUBSCRIPTION;
    }
  });

  it("ПУСТАЯ строка в env — это не «никогда», а дефолт (Number(\"\") === 0)", async () => {
    process.env.JARVIS_PRIMARY_RECHECK_MS = "";
    let clock = 0;
    const primary = primaryWithFailure(CREDITS);
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary, {}, () => clock);
    await p.complete(REQ);
    clock += 6 * 3_600_000 + 1_000; // дефолтные 6 часов
    await p.complete(REQ);
    expect(primary.calls).toBe(2); // перепроверка состоялась, канал не выключен навсегда молча
  });

  it("стрим идёт тем же путём: выключенный канал не трогаем", async () => {
    const primary = primaryWithFailure(CREDITS);
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary);
    await p.completeStream(REQ, () => {});
    await p.completeStream(REQ, () => {});
    await p.completeStream(REQ, () => {});
    expect(primary.calls).toBe(1);
  });
});

describe("W0 (2026-09-09): стрим основного канала пробрасывается СРАЗУ, а не после генерации", () => {
  /** Основной канал, который отдаёт дельты по одной и ждёт разрешения завершиться. */
  function slowPrimary(deltas: string[], final: LlmResponse) {
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    const p = {
      live: true,
      calls: 0,
      async complete(): Promise<LlmResponse> {
        p.calls += 1;
        return final;
      },
      async completeStream(_r: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
        p.calls += 1;
        for (const t of deltas) onDelta({ text: t });
        await done;
        return final;
      },
      release: () => release(),
    };
    return p;
  }

  it("первая дельта доходит до потребителя ДО завершения ответа основного канала (реверт: буферизация — падает)", async () => {
    const primary = slowPrimary(["Секунду, ", "сэр."], resp({ text: "Секунду, сэр." }));
    const secondary = fake({ live: true });
    const p = new FallbackLlmProvider(primary, secondary);
    const seen: string[] = [];
    const pending = p.completeStream(REQ, (d) => seen.push(d.text));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["Секунду, ", "сэр."]); // уже пришли, хотя ответ ещё не завершён
    primary.release();
    const r = await pending;
    expect(r.text).toBe("Секунду, сэр.");
    expect(secondary.calls).toBe(0);
  });

  it("основной оборвался ПОСЛЕ выдачи дельт → честный стаб, резерв НЕ зовём (двойного голоса нет)", async () => {
    const primary = slowPrimary(["Начал..."], STUB);
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary);
    const seen: string[] = [];
    const pending = p.completeStream(REQ, (d) => seen.push(d.text));
    await new Promise((r) => setTimeout(r, 0));
    primary.release();
    const r = await pending;
    expect(r.stubbed).toBe(true);
    expect(secondary.calls).toBe(0);
    expect(seen).toEqual(["Начал..."]);
  });

  it("основной отказал ДО первой дельты → резерв со стримом, как раньше", async () => {
    const primary = fake({ live: true, result: STUB });
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(primary, secondary);
    const seen: string[] = [];
    const r = await p.completeStream(REQ, (d) => seen.push(d.text));
    expect(r.text).toBe("по подписке");
    expect(seen).toEqual(["по подписке"]);
  });
});

/**
 * C3 ПРОВОДКОЙ: настоящий AnthropicLlmProvider (подменён только HTTP-клиент SDK) бросает 403 гео-блока так,
 * как бросает SDK (`status` + `${status} ${body}`), дальше — настоящая классификация, настоящий стаб и
 * настоящая фолбэк-цепочка. Владелец при двух лёгших каналах слышит про VPN, а не «ключ не принят».
 */
describe("403 гео-блока через настоящий провайдер API (C3)", () => {
  const REGION_403 = '403 {"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}';

  /** Настоящий провайдер API, чей HTTP-клиент бросает так, как бросает SDK (`status` + `${status} ${body}`). */
  function realPrimaryFailing(calls: { n: number }, text: string, status: number): AnthropicLlmProvider {
    const p = new AnthropicLlmProvider({ apiKey: "sk-test", maxRetries: 0 });
    const fail = async (): Promise<never> => {
      calls.n += 1;
      throw Object.assign(new Error(text), { status });
    };
    (p as unknown as { clientPromise: Promise<unknown> }).clientPromise = Promise.resolve({ messages: { create: fail, stream: fail } });
    return p;
  }
  const realPrimaryThrowing403 = (calls = { n: 0 }): AnthropicLlmProvider => realPrimaryFailing(calls, REGION_403, 403);

  /**
   * Резерв «как в бою» при гео-блоке: пока VPN не поднят, CLI подписки ТОЖЕ получает 403 (настоящий провайдер
   * записывает причину до броска — так же и здесь); `down=false` — VPN поднялся, подписка отвечает.
   */
  function flakySubscription(): ILlmProvider & { down: boolean; calls: number } {
    const CLI_403 = "Failed to authenticate. API Error: 403 Request not allowed";
    const s = {
      live: true,
      down: true,
      calls: 0,
      async complete(): Promise<LlmResponse> {
        s.calls += 1;
        if (!s.down) return resp({ text: "по подписке" });
        _setSubscriptionFailureForTest(CLI_403);
        throw new Error(`подписка: ${CLI_403}`);
      },
      async completeStream(): Promise<LlmResponse> {
        return s.complete();
      },
    };
    return s;
  }

  const resetReasons = (): void => {
    _resetApiFailureForTest();
    _resetSubscriptionFailureForTest(); // причина резерва из соседних кейсов не должна подменить нашу (TTL 30 мин)
  };
  beforeEach(resetReasons);
  afterEach(resetReasons);

  it("оба канала недоступны → честный стаб с советом про VPN, не про ключ", async () => {
    const p = new FallbackLlmProvider(realPrimaryThrowing403(), fake({ live: false }));
    const r = await p.complete(REQ);
    expect(r.stubbed).toBe(true);
    expect(r.text).toMatch(/VPN/); // до фикса: «Ключ доступа к модели не принят…»
    expect(r.text).not.toMatch(/ключ/i);
  });

  /**
   * Адверс-ревью р1: «как в бою» — НАСТОЯЩИЙ провайдер подписки (подменён только SDK). CLI без терминала шлёт 403
   * гео-блока строкой «Failed to authenticate. API Error: 403 Request not allowed» (claude.exe 0.3.251), провайдер
   * сам классифицирует её ДО броска, и withKnownReason берёт ЕГО причину. Фейк, бросающий без записи причины,
   * этот путь прятал: до фикса владелец слышал «разлогинился… claude setup-token» вместо VPN.
   */
  it("резерв (настоящий провайдер подписки) тоже получил 403 гео-блока в обёртке CLI → про VPN, не setup-token", async () => {
    const CLI_403 = "Failed to authenticate. API Error: 403 Request not allowed";
    const sdk: SdkModule = {
      query: () =>
        (async function* () {
          yield { type: "assistant", message: { content: [{ type: "text", text: CLI_403 }] } };
          yield { type: "result", subtype: "success", is_error: true, api_error_status: 403, result: CLI_403 };
        })(),
      tool: (name: string) => ({ name }),
      createSdkMcpServer: (opts) => ({ type: "sdk", name: opts.name, tools: opts.tools }),
    };
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test"; // live без сохранённого логина
    try {
      const p = new FallbackLlmProvider(realPrimaryThrowing403(), new SubscriptionLlmProvider({ loadSdk: async () => sdk }));
      const r = await p.complete(REQ);
      expect(r.stubbed).toBe(true);
      expect(r.text).toMatch(/VPN/);
      expect(r.text).not.toMatch(/setup-token|разлогин/u); // до фикса: «доступ по подписке разлогинился…»
    } finally {
      if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    }
  });

  // Адверс-ревью р1 (LOW): пока VPN не поднят, гео-блок за 5 минут не лечится — общая пауза предохранителя
  // возвращала по 2 заведомо мёртвых вызова в каждое 5-минутное окно. Для region пауза длиннее (30 мин).
  it("гео-блок подряд → основной канал пропускается 30 минут, а не общие 5", async () => {
    const calls = { n: 0 };
    let clock = 0;
    const secondary = fake({ live: true, result: resp({ text: "по подписке" }) });
    const p = new FallbackLlmProvider(realPrimaryThrowing403(calls), secondary, {}, () => clock);
    await p.complete(REQ);
    await p.complete(REQ);
    expect(calls.n).toBe(2);
    clock += 400_000; // общая 5-минутная пауза уже истекла бы
    expect((await p.complete(REQ)).text).toBe("по подписке");
    expect(calls.n).toBe(2); // до фикса: 3 — снова обречённый вызов API
    expect(p.channelStatus().primary).toBe("cooldown"); // транзиентно, не латч «ключ»
    clock += 30 * 60_000;
    await p.complete(REQ);
    expect(calls.n).toBe(3); // полуоткрытая проба: вдруг VPN уже поднят
  });
  // ↑ Резерв здесь отвечает ВСЕГДА — и пауза держится: успех подписки, которая не падала вместе с API, НЕ доказывает,
  // что гео-блок снят (маршрут CLI может идти иначе). Снимать по такому успеху = 2 мёртвых вызова API каждые 3 хода.

  /**
   * Адверс-ревью р2 (LOW): вход в Windows без VPN — гео-403 у ОБОИХ каналов, пауза основного встала на 30 мин. VPN
   * поднялся через секунды, подписка ответила — сеть доказанно починилась, а быстрый канал ещё полчаса пропускался и
   * паспорт твердил «основной канал временно не отвечает». Успех подписки ПОСЛЕ её же провала снимает паузу досрочно.
   */
  it("гео-блок у обоих каналов, потом подписка ответила → пауза основного снята досрочно", async () => {
    const calls = { n: 0 };
    let clock = 0;
    const secondary = flakySubscription();
    const p = new FallbackLlmProvider(realPrimaryThrowing403(calls), secondary, {}, () => clock);
    await p.complete(REQ);
    expect((await p.complete(REQ)).stubbed).toBe(true); // пауза встала; подписка тоже 403 — VPN не поднят
    expect(p.channelStatus().primary).toBe("cooldown");
    secondary.down = false; // VPN поднялся
    clock += 5_000;
    expect((await p.complete(REQ)).text).toBe("по подписке");
    expect(calls.n).toBe(2); // этот ход ещё без API — пауза действовала на его старте
    expect(p.channelStatus().primary).toBe("ok"); // до фикса: «cooldown» ещё ~30 минут
    await p.complete(REQ);
    expect(calls.n).toBe(3); // до фикса: 2 — быстрый канал пропускался при живой сети
    expect(p.channelStatus().primary).toBe("ok"); // счётчик тоже сброшен: одна новая неудача — ещё не пауза
  });

  it("снятие — только при ДЕЙСТВУЮЩЕЙ паузе: после её истечения успех подписки счётчик отказов API не обнуляет", async () => {
    const calls = { n: 0 };
    let clock = 0;
    const secondary = flakySubscription();
    const p = new FallbackLlmProvider(realPrimaryThrowing403(calls), secondary, {}, () => clock);
    await p.complete(REQ);
    await p.complete(REQ); // пауза гео-блока; подписка тоже падает все 30 минут
    clock += 30 * 60_000;
    secondary.down = false;
    await p.complete(REQ); // полуоткрытая проба: API снова 403 (1-я неудача), подписка ответила — паузы нет, снимать нечего
    await p.complete(REQ); // 2-я неудача подряд → пауза встаёт снова
    expect(calls.n).toBe(4);
    expect(p.channelStatus().primary).toBe("cooldown"); // без гарда паузы: счётчик обнулён, «ok» и новые мёртвые вызовы
  });

  it("пауза НЕ гео-блока (429 / причина неизвестна) успехом подписки после её провала не снимается", async () => {
    const setups = [
      () => {
        const calls = { n: 0 };
        return { primary: realPrimaryFailing(calls, "429 rate limit exceeded", 429), calls: () => calls.n };
      },
      () => {
        const f = fake({ live: true, result: STUB }); // стаб без записанной причины — kind неизвестен
        return { primary: f, calls: () => f.calls };
      },
    ];
    for (const setup of setups) {
      resetReasons();
      const { primary, calls } = setup();
      let clock = 0;
      const secondary = flakySubscription();
      const p = new FallbackLlmProvider(primary, secondary, {}, () => clock);
      await p.complete(REQ);
      await p.complete(REQ);
      secondary.down = false;
      clock += 5_000;
      await p.complete(REQ);
      await p.complete(REQ);
      expect(calls()).toBe(2); // лимит/сбой самого API успех подписки не лечит — обычная пауза держится
      expect(p.channelStatus().primary).toBe("cooldown");
    }
  });

  it("резерв жив → ход по подписке, а API-канал в паспорте НЕ выключен как «ключ»", async () => {
    const p = new FallbackLlmProvider(realPrimaryThrowing403(), fake({ live: true, result: resp({ text: "по подписке" }) }));
    const r = await p.complete(REQ);
    expect(r.text).toBe("по подписке");
    const st = p.channelStatus();
    expect(st.primary).not.toBe("off"); // до фикса: off / kind auth — латч на 6 часов
    expect(st.kind).not.toBe("auth");
  });
});

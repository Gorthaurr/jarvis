// Волна G: резерв мозга на подписке — переключение каналов и ЧЕСТНОСТЬ исходов.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetApiFailureForTest, _setApiFailureForTest } from "./anthropic.js";
import { FallbackLlmProvider } from "./fallback-llm.js";
import { _resetSubscriptionFailureForTest, _setSubscriptionFailureForTest } from "./subscription-llm.js";
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
      if (r.text) onDelta({ text: r.text });
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

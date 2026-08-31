// Волна G: резерв мозга на подписке — переключение каналов и ЧЕСТНОСТЬ исходов.
import { describe, expect, it, vi } from "vitest";
import { FallbackLlmProvider } from "./fallback-llm.js";
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

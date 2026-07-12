import { describe, expect, it } from "vitest";
import { LatencyTracker } from "./latency.js";

describe("LatencyTracker (§10)", () => {
  it("меряет turn_end → первый звук и сверяет с целью 800мс", () => {
    let t = 0;
    const lt = new LatencyTracker(() => t);
    t = 1000;
    lt.mark("turn_end");
    t = 1200;
    lt.mark("llm_first_token");
    t = 1450;
    lt.mark("tts_first_chunk");
    lt.mark("audio");
    const r = lt.report();
    expect(r.firstAudioMs).toBe(450);
    expect(r.llmFirstTokenMs).toBe(200);
    expect(r.ttsFirstChunkMs).toBe(450);
    expect(r.withinTarget).toBe(true);
  });

  it("отмечает превышение цели", () => {
    let t = 0;
    const lt = new LatencyTracker(() => t);
    t = 0;
    lt.mark("turn_end");
    t = 1200;
    lt.mark("audio");
    expect(lt.report().withinTarget).toBe(false);
  });

  it("mark идемпотентен (первая метка стадии выигрывает)", () => {
    let t = 100;
    const lt = new LatencyTracker(() => t);
    lt.mark("turn_end");
    t = 999;
    lt.mark("turn_end");
    expect(lt.report().marks.turn_end).toBe(100);
  });

  it("без стадии audio firstAudioMs undefined", () => {
    const lt = new LatencyTracker(() => 0);
    lt.mark("turn_end");
    expect(lt.report().firstAudioMs).toBeUndefined();
    expect(lt.report().withinTarget).toBeUndefined();
  });

  it("инкремент 0: audio_played (mouth-to-ear) — отдельная метка, звук отправлен ≠ звук сыгран", () => {
    let t = 0;
    const lt = new LatencyTracker(() => t);
    t = 1000;
    lt.mark("turn_end");
    t = 1450;
    lt.markAt("audio", 1450); // сервер ОТПРАВИЛ первый чанк (turn_end+450)
    lt.markAt("audio_played", 1620); // клиент реально начал воспроизведение (turn_end+620, сеть+буфер)
    const r = lt.report();
    expect(r.firstAudioMs).toBe(450); // отправлено
    expect(r.firstAudioPlayedMs).toBe(620); // реально сыграно (главная §10 метрика)
    expect(r.summary).toContain("→ухо 620мс");
    expect(r.withinTarget).toBe(true); // 620 ≤ 800 — считаем по РЕАЛЬНОМУ звуку
  });

  it("инкремент 0: §10 «уложились» считается по audio_played, когда он есть (не по отправке)", () => {
    let t = 0;
    const lt = new LatencyTracker(() => t);
    t = 0;
    lt.mark("turn_end");
    lt.markAt("audio", 700); // отправлено в 700 (в цель)
    lt.markAt("audio_played", 900); // но реально сыграно в 900 (ЗА целью 800)
    expect(lt.report().withinTarget).toBe(false); // по mouth-to-ear — превышение
  });

  it("инкремент 0 (ревью #2): отрицательная played-дельта НЕ маскирует превышение (fallback на отправку)", () => {
    let t = 0;
    const lt = new LatencyTracker(() => t);
    t = 1000;
    lt.mark("turn_end");
    lt.markAt("audio", 2500); // отправлено +1500 — УЖЕ за целью 800
    lt.markAt("audio_played", 800); // ts клиента ДО turn_end (clock-skew/мис-корр) → дельта −200
    const r = lt.report();
    expect(r.firstAudioPlayedMs).toBe(-200);
    expect(r.withinTarget).toBe(false); // отрицательный played игнорируется → считаем по отправке 1500 > 800
  });

  it("инкремент 0: без audio_played firstAudioPlayedMs undefined, withinTarget по отправке (старый клиент)", () => {
    let t = 0;
    const lt = new LatencyTracker(() => t);
    lt.mark("turn_end");
    t = 700;
    lt.mark("audio");
    const r = lt.report();
    expect(r.firstAudioPlayedMs).toBeUndefined();
    expect(r.withinTarget).toBe(true); // фолбэк на firstAudioMs
  });
});

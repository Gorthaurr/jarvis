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
});

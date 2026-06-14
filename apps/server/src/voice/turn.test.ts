import { describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_CONFIG,
  HeuristicTurnDetector,
  TurnDetector,
  decideEndpoint,
} from "./turn.js";

const det = new HeuristicTurnDetector();

describe("HeuristicTurnDetector (RU, §10)", () => {
  it("терминальная пунктуация → высокая завершённость", () => {
    expect(det.predictComplete("во сколько встреча?")).toBeGreaterThan(0.9);
  });
  it("незавершающий хвост (союз/предлог) → низкая завершённость", () => {
    expect(det.predictComplete("я хочу чтобы")).toBeLessThan(0.3);
    expect(det.predictComplete("напиши маше и")).toBeLessThan(0.3);
  });
  it("длинная законченная мысль без точки → умеренно высокая", () => {
    expect(det.predictComplete("закажи как обычно из той пиццерии")).toBeGreaterThanOrEqual(0.6);
  });
});

describe("decideEndpoint (§10)", () => {
  it("тишина больше maxSilence → endpoint независимо от семантики", () => {
    expect(decideEndpoint("я хочу чтобы", 1000, det)).toBe("endpoint");
  });
  it("тишина меньше minSilence → wait", () => {
    expect(decideEndpoint("во сколько встреча?", 100, det)).toBe("wait");
  });
  it("в зоне minSilence — решает семантика", () => {
    expect(decideEndpoint("во сколько встреча?", 400, det)).toBe("endpoint");
    expect(decideEndpoint("я хочу чтобы", 400, det)).toBe("wait");
  });
});

describe("TurnDetector с инъекцией часов", () => {
  it("копит тишину между speech_end и tick", () => {
    let t = 0;
    const td = new TurnDetector(det, DEFAULT_TURN_CONFIG, () => t);
    td.onInterim("эм");
    t = 1000;
    td.onSpeechStart();
    t = 1100;
    // первая фиксация тишины: 0 мс прошло
    expect(td.onSpeechEnd()).toBe("wait");
    t = 1100 + DEFAULT_TURN_CONFIG.maxSilenceMs; // тишина дотянула до жёсткого порога
    expect(td.tick()).toBe("endpoint");
  });

  it("после endpoint сбрасывает состояние", () => {
    let t = 0;
    const td = new TurnDetector(det, DEFAULT_TURN_CONFIG, () => t);
    td.onInterim("готово.");
    t = 500;
    expect(td.onSpeechEnd()).toBe("wait"); // 0 мс тишины < minSilence
    t = 800; // 300 мс тишины, семантика «готово.» высокая
    expect(td.tick()).toBe("endpoint");
    // после сброса tick без новой речи → wait
    expect(td.tick()).toBe("wait");
  });
});

/** W2: кап кадра по семейству/поколению модели (справочник claude-api, кеш 2026-06-24). */
import { describe, expect, it } from "vitest";
import { VISION_CAPS, visionCapFor, visionLevel } from "./vision-caps.js";

describe("visionLevel", () => {
  it.each([
    ["claude-opus-5", "high"],
    ["claude-opus-5-5", "high"],
    ["claude-opus-4-8", "high"],
    ["claude-opus-4-7", "high"],
    ["claude-opus-4-6", "std"],
    ["claude-opus-4-20250514", "std"],
    ["claude-sonnet-5", "high"],
    ["claude-sonnet-4-6", "std"],
    ["claude-haiku-4-5", "std"],
    ["claude-fable-5", "high"],
    ["claude-fable-5-1", "high"],
    ["claude-opus-5[1m]", "high"],
    ["us.anthropic.claude-opus-4-8-v1:0", "high"],
    ["opus", "high"],
    ["fable", "high"],
    ["haiku", "std"],
    ["sonnet", "std"],
    ["gpt-5", "std"],
    ["", "std"],
  ])("%s → %s", (id, level) => {
    expect(visionLevel(id)).toBe(level);
  });
});

describe("visionCapFor", () => {
  it("high = 1920 кадр / 2576 / 3,75 Мп; std = 1568 / 1568 / 1,15 Мп", () => {
    expect(VISION_CAPS.high).toEqual({ frameEdge: 1920, maxEdge: 2576, maxPixels: 3_750_000 });
    expect(VISION_CAPS.std).toEqual({ frameEdge: 1568, maxEdge: 1568, maxPixels: 1_150_000 });
  });

  it("минимум по набору: подписка Opus 5 + тир API Sonnet 4.6 → std; только Opus 5 → high; пусто → std", () => {
    expect(visionCapFor(["claude-opus-5", "claude-sonnet-4-6"])).toEqual(VISION_CAPS.std);
    expect(visionCapFor(["claude-opus-5", "claude-fable-5-1"])).toEqual(VISION_CAPS.high);
    expect(visionCapFor([])).toEqual(VISION_CAPS.std);
    expect(visionCapFor([undefined, ""])).toEqual(VISION_CAPS.std);
  });
});

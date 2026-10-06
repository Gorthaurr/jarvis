import { describe, expect, it } from "vitest";
import { deepgramLiveReason } from "./availability.js";

describe("платный live STT требует отдельного согласия", () => {
  it("наличие ключа не включает Deepgram", () => {
    expect(deepgramLiveReason({ DEEPGRAM_API_KEY: "dummy" })).toContain("LAB_LIVE_DEEPGRAM=1");
  });
  it("только явная единица включает прогон", () => {
    expect(deepgramLiveReason({ LAB_LIVE_DEEPGRAM: "true" })).not.toBe("");
    expect(deepgramLiveReason({ LAB_LIVE_DEEPGRAM: "1" })).toBe("");
  });
  it("общий запрет live имеет приоритет", () => {
    expect(deepgramLiveReason({ LAB_SKIP_LIVE: "1", LAB_LIVE_DEEPGRAM: "1" })).toBe("LAB_SKIP_LIVE=1");
  });
});

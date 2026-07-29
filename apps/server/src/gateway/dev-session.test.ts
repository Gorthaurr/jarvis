/**
 * Гейт dev-сессий. Критично для ЧЕСТНОСТИ доклада о сбоях: доклад одноразовый (durable-маркер), и
 * прогон текст-драйвера/смоука не должен «съесть» то, что предназначено владельцу.
 */
import { describe, expect, it } from "vitest";

// КОНТРОЛЬ-6 (HIGH): собственные QA-драйверы репозитория представлялись как «qa»/«qa-slow» и проходили
// как ЖИВОЙ владелец — съедали ровно те одноразовые ресурсы, ради защиты которых гейт и существует
// (недоставленные напоминания, ambient-уведомления, отложенные поручения watch, доклад о сбоях).
describe("isDevSession — все драйверы репозитория опознаны", () => {
  it("_jarvis_cmd.mjs / _qa_battery.mjs / _qa_slow.mjs", async () => {
    const { isDevSession } = await import("./dev-session.js");
    for (const v of ["cmd-test", "qa", "qa-slow", "smoke", "probe-1", "bench", "driver", "test-2"]) {
      expect(isDevSession(v), v).toBe(true);
    }
  });

  it("живой клиент владельца НЕ считается dev-сессией", async () => {
    const { isDevSession } = await import("./dev-session.js");
    for (const v of ["0.1.0", "jarvis-client", "1.2.3-electron", undefined]) {
      expect(isDevSession(v), String(v)).toBe(false);
    }
  });
});
import { isDevSession } from "./dev-session.js";

describe("isDevSession", () => {
  it("текст-драйвер и смоуки распознаются как dev", () => {
    expect(isDevSession("cmd-test")).toBe(true); // _jarvis_cmd.mjs
    expect(isDevSession("driver")).toBe(true);
    expect(isDevSession("smoke-TEST")).toBe(true); // регистр не важен
  });

  it("живой клиент владельца — НЕ dev (доклад/приветствие ему положены)", () => {
    expect(isDevSession("0.1.0")).toBe(false);
    expect(isDevSession("1.4.2")).toBe(false);
  });

  it("отсутствующий clientVersion — не dev (консервативно: лучше доложить владельцу)", () => {
    expect(isDevSession(undefined)).toBe(false);
    expect(isDevSession("")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { successPhrase } from "./action-phrases.js";

describe("пауза без звука (ревью 2026-09-24, B-F2)", () => {
  it("клиент клавишу не жал (already) → «уже тихо», а не «поставил на паузу»", () => {
    for (let i = 0; i < 10; i++) {
      const p = successPhrase({ kind: "media", op: "pause" } as never, { already: true });
      expect(p).toMatch(/тихо|ничего не играет/u);
      expect(p).not.toMatch(/Поставил|Остановил|Пауза/u);
    }
  });

  it("звук шёл, клавиша нажата → обычная фраза паузы", () => {
    const p = successPhrase({ kind: "media", op: "pause" } as never, { ok: true });
    expect(p).toMatch(/Пауза|Поставил на паузу|Остановил/u);
  });
});

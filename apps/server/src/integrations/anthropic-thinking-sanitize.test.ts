import { describe, expect, it } from "vitest";
import { parseResponse, sanitizeThinkingContent } from "./anthropic.js";

// Живой 400 2026-07-24 (req_011CdM7PdZVtp4FXHLpe9GNd): Opus adaptive вернул thinking-блок с ПУСТЫМ
// текстом; реплей блока в следующий раунд → «messages.40.content.0.thinking: each thinking block must
// contain thinking» → аварийный стаб «Связь прервалась» на КАЖДОМ follow-up. Два рубежа защиты.

describe("parseResponse — пустой thinking-каркас не сохраняется (рубеж 1)", () => {
  it("thinking с пустой/пробельной строкой выбрасывается, непустой — сохраняется", () => {
    const r = parseResponse({
      content: [
        { type: "thinking", thinking: "", signature: "sig1" },
        { type: "thinking", thinking: "  \n ", signature: "sig2" },
        { type: "thinking", thinking: "реальное размышление", signature: "sig3" },
        { type: "tool_use", id: "t1", name: "browser_tabs", input: {} },
      ],
      stop_reason: "tool_use",
    } as never);
    expect(r.thinkingBlocks).toHaveLength(1);
    expect(r.thinkingBlocks?.[0]).toMatchObject({ type: "thinking", thinking: "реальное размышление" });
    expect(r.toolUses).toHaveLength(1);
  });

  it("ответ ТОЛЬКО с пустым thinking → thinkingBlocks отсутствует вовсе", () => {
    const r = parseResponse({
      content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "Готово." }],
      stop_reason: "end_turn",
    } as never);
    expect(r.thinkingBlocks).toBeUndefined();
    expect(r.text).toBe("Готово.");
  });

  it("redacted_thinking сохраняется как раньше (регресс)", () => {
    const r = parseResponse({
      content: [{ type: "redacted_thinking", data: "abc123" }],
      stop_reason: "end_turn",
    } as never);
    expect(r.thinkingBlocks).toEqual([{ type: "redacted_thinking", data: "abc123" }]);
  });
});

describe("sanitizeThinkingContent — страховка сериализации (рубеж 2)", () => {
  it("строковый content не трогается", () => {
    expect(sanitizeThinkingContent("привет")).toBe("привет");
  });

  it("массив без пустых thinking возвращается КАК ЕСТЬ (та же ссылка — кеш-стабильность)", () => {
    const content = [{ type: "thinking", thinking: "мысль", signature: "s" }, { type: "text", text: "ок" }];
    expect(sanitizeThinkingContent(content)).toBe(content);
  });

  it("пустой thinking выбрасывается, остальные блоки целы", () => {
    const out = sanitizeThinkingContent([
      { type: "thinking", thinking: "", signature: "s" },
      { type: "tool_use", id: "t", name: "x", input: {} },
    ]) as Array<{ type: string }>;
    expect(out.map((b) => b.type)).toEqual(["tool_use"]);
  });

  it("cache_control выброшенного блока переносится на последний оставшийся (§15 rolling-брейкпоинт)", () => {
    const out = sanitizeThinkingContent([
      { type: "text", text: "ответ" },
      { type: "thinking", thinking: "", signature: "s", cache_control: { type: "ephemeral" } },
    ]) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(out[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("cache_control НЕ перетирает существующий у последнего блока", () => {
    const out = sanitizeThinkingContent([
      { type: "text", text: "ответ", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "thinking", thinking: "", signature: "s", cache_control: { type: "ephemeral" } },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("ВСЁ содержимое было пустым thinking → text-заглушка «…» (пустой content — тоже 400)", () => {
    const out = sanitizeThinkingContent([
      { type: "thinking", thinking: "", signature: "s", cache_control: { type: "ephemeral" } },
    ]) as Array<Record<string, unknown>>;
    expect(out).toEqual([{ type: "text", text: "…", cache_control: { type: "ephemeral" } }]);
  });
});

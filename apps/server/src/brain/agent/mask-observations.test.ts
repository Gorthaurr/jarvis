/**
 * Волна C: свёртка старых перечитываемых наблюдений (mask-observations).
 *
 * Проверяем ЗАКОНЫ, а не реализацию: не трогаем результаты действий (mutate), не трогаем свежее,
 * заглушка честная (велит перечитать), историю без выгоды не мутируем.
 */
import { describe, expect, it } from "vitest";
import type { LlmMessage } from "../../integrations/llm.js";
import { isRefetchableTool, maskOldObservations } from "./mask-observations.js";

const BIG = "x".repeat(4000);

/** Раунд: assistant(tool_use) + user(tool_result со строковым/блочным содержимым). */
function round(id: string, tool: string, text: string, asArray = true): LlmMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name: tool, input: {} }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: asArray ? [{ type: "text", text }] : text }],
    },
  ];
}

function textOf(convo: LlmMessage[], msgIdx: number): string {
  const msg = convo[msgIdx]!;
  if (typeof msg.content === "string") return msg.content;
  const tr = msg.content.find((b) => b.type === "tool_result");
  if (!tr || tr.type !== "tool_result") return "";
  if (typeof tr.content === "string") return tr.content;
  return tr.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("");
}

describe("isRefetchableTool", () => {
  it("чтения и сверки перечитываемы, действия — нет", () => {
    expect(isRefetchableTool("web_fetch")).toBe(true); // neutral
    expect(isRefetchableTool("browser_read")).toBe(true); // verify
    expect(isRefetchableTool("ui_snapshot")).toBe(true);
    expect(isRefetchableTool("code_run")).toBe(false); // mutate — stdout это ЗАПИСЬ о сделанном
    expect(isRefetchableTool("telegram_send")).toBe(false);
    expect(isRefetchableTool("fs_write")).toBe(false);
  });
});

describe("maskOldObservations", () => {
  it("сворачивает СТАРОЕ чтение и оставляет свежие раунды нетронутыми", () => {
    const convo: LlmMessage[] = [
      { role: "user", content: "найди что-нибудь" },
      ...round("a", "web_fetch", BIG),
      ...round("b", "browser_read", BIG),
      ...round("c", "screen_read_text", BIG),
    ];
    const res = maskOldObservations(convo, { keepRecent: 2, minChars: 100 });
    expect(res.masked).toBe(1);
    expect(res.freedChars).toBeGreaterThan(3000);
    expect(textOf(convo, 2)).toContain("свёрнуто");
    expect(textOf(convo, 4)).toBe(BIG); // предпоследний раунд — свежий
    expect(textOf(convo, 6)).toBe(BIG); // последний раунд — свежий
  });

  it("НИКОГДА не сворачивает результат меняющего действия (запись о сделанном)", () => {
    const convo: LlmMessage[] = [
      { role: "user", content: "сделай" },
      ...round("a", "code_run", BIG),
      ...round("b", "telegram_send", BIG),
      ...round("c", "web_fetch", BIG),
      ...round("d", "web_fetch", BIG),
    ];
    const res = maskOldObservations(convo, { keepRecent: 0, minChars: 100 });
    expect(res.masked).toBe(2); // только два web_fetch
    expect(textOf(convo, 2)).toBe(BIG); // code_run цел
    expect(textOf(convo, 4)).toBe(BIG); // telegram_send цел
    expect(textOf(convo, 6)).toContain("свёрнуто");
    expect(textOf(convo, 8)).toContain("свёрнуто");
  });

  it("останавливается, как только освобождено targetChars (историю сверх нужды не курочит)", () => {
    const convo: LlmMessage[] = [
      { role: "user", content: "go" },
      ...round("a", "web_fetch", BIG),
      ...round("b", "web_fetch", BIG),
      ...round("c", "web_fetch", BIG),
    ];
    const res = maskOldObservations(convo, { keepRecent: 0, minChars: 100, targetChars: 1000 });
    expect(res.masked).toBe(1);
    expect(textOf(convo, 2)).toContain("свёрнуто");
    expect(textOf(convo, 4)).toBe(BIG);
    expect(textOf(convo, 6)).toBe(BIG);
  });

  it("мелкие наблюдения не трогает (перезапись кеша дороже экономии)", () => {
    const convo: LlmMessage[] = [{ role: "user", content: "go" }, ...round("a", "web_fetch", "коротко"), ...round("b", "web_fetch", BIG)];
    const res = maskOldObservations(convo, { keepRecent: 0, minChars: 1200 });
    expect(res.masked).toBe(1);
    expect(textOf(convo, 2)).toBe("коротко");
  });

  it("строковый tool_result сворачивается, а НЕ подходящий под свёртку строковый не превращается в массив", () => {
    const convo: LlmMessage[] = [
      { role: "user", content: "go" },
      ...round("a", "web_fetch", BIG, false),
      ...round("b", "web_fetch", "мало", false),
      ...round("c", "browser_read", BIG, false),
    ];
    maskOldObservations(convo, { keepRecent: 1, minChars: 1200 });
    expect(textOf(convo, 2)).toContain("свёрнуто");
    // форма НЕ тронутого мелкого результата осталась строкой (история не переписана впустую)
    const untouched = convo[4]!;
    const block = typeof untouched.content === "string" ? undefined : untouched.content[0];
    expect(block && block.type === "tool_result" && typeof block.content).toBe("string");
    expect(textOf(convo, 6)).toBe(BIG); // свежий раунд цел
  });

  it("заглушка ЧЕСТНАЯ: называет инструмент и запрещает выдавать память за прочитанное", () => {
    const convo: LlmMessage[] = [{ role: "user", content: "go" }, ...round("a", "web_fetch", BIG)];
    maskOldObservations(convo, { keepRecent: 0, minChars: 100 });
    const stub = textOf(convo, 2);
    expect(stub).toContain("web_fetch");
    expect(stub).toContain("ПЕРЕЧИТАЙ");
    expect(stub).toContain("НЕ сохранено");
  });

  it("осиротевший результат (имя инструмента неизвестно) не трогается", () => {
    const convo: LlmMessage[] = [
      { role: "user", content: "go" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: [{ type: "text", text: BIG }] }] },
      ...round("b", "web_fetch", BIG),
      ...round("c", "web_fetch", BIG),
    ];
    const res = maskOldObservations(convo, { keepRecent: 0, minChars: 100 });
    expect(textOf(convo, 1)).toBe(BIG);
    expect(res.masked).toBe(2);
  });

  it("картинки не трогает (это забота pruneStaleImages)", () => {
    const convo: LlmMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "screen_capture", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "a",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
          },
        ],
      },
    ];
    const res = maskOldObservations(convo, { keepRecent: 0, minChars: 1 });
    expect(res.masked).toBe(0);
  });

  it("пустой/безынструментальный convo — no-op", () => {
    const convo: LlmMessage[] = [{ role: "user", content: "привет" }];
    expect(maskOldObservations(convo, { keepRecent: 0 })).toEqual({ masked: 0, freedChars: 0 });
    expect(maskOldObservations([], {})).toEqual({ masked: 0, freedChars: 0 });
  });
});

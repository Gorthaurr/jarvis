/** §скорость (зрение): тесты вырезки устаревших скриншотов из convo (prune-images.ts). */
import { describe, expect, it } from "vitest";
import type { LlmMessage, ToolResultContent } from "../../integrations/llm.js";
import { pruneStaleImages } from "./prune-images.js";

/** user-ход с tool_result, содержащим скрин (image-блок) + текст. */
function shotMsg(id: string): LlmMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: [
          { type: "text", text: `скрин ${id}` },
          { type: "image", source: { type: "base64", media_type: "image/png", data: `png-${id}` } },
        ],
      },
    ],
  };
}

/** все image-блоки convo (для проверки, что осталось). */
function imagesIn(convo: LlmMessage[]): string[] {
  const out: string[] = [];
  for (const m of convo) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || typeof b.content === "string") continue;
      for (const c of b.content) if (c.type === "image") out.push(c.source.data);
    }
  }
  return out;
}

describe("pruneStaleImages", () => {
  it("меньше keep изображений — ничего не трогает", () => {
    const convo = [shotMsg("a"), shotMsg("b")];
    expect(pruneStaleImages(convo, 2)).toBe(0);
    expect(imagesIn(convo)).toEqual(["png-a", "png-b"]);
  });

  it("старые скрины заменяются заглушкой, последние keep остаются", () => {
    const convo = [shotMsg("a"), shotMsg("b"), shotMsg("c"), shotMsg("d")];
    expect(pruneStaleImages(convo, 2)).toBe(2);
    expect(imagesIn(convo)).toEqual(["png-c", "png-d"]);
    // на месте старого кадра — текстовая заглушка (пара tool_use/tool_result не ломается)
    const first = convo[0]!.content as Extract<LlmMessage["content"], unknown[]>;
    const tr = first[0] as { type: "tool_result"; content: ToolResultContent[] };
    expect(tr.content).toHaveLength(2);
    expect(tr.content[1]!.type).toBe("text");
    expect((tr.content[1] as { text: string }).text).toContain("устарел");
    // сопровождающий текстовый блок результата цел
    expect((tr.content[0] as { text: string }).text).toBe("скрин a");
  });

  it("идемпотентна: повторный вызов ничего не вырезает заново", () => {
    const convo = [shotMsg("a"), shotMsg("b"), shotMsg("c")];
    expect(pruneStaleImages(convo, 2)).toBe(1);
    expect(pruneStaleImages(convo, 2)).toBe(0);
    expect(imagesIn(convo)).toEqual(["png-b", "png-c"]);
  });

  it("несколько картинок в одном tool_result учитываются по отдельности", () => {
    const multi: LlmMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "m",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "png-1" } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "png-2" } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "png-3" } },
          ],
        },
      ],
    };
    const convo = [multi];
    expect(pruneStaleImages(convo, 2)).toBe(1);
    expect(imagesIn(convo)).toEqual(["png-2", "png-3"]);
  });

  it("string-content и assistant-ходы не трогаются", () => {
    const convo: LlmMessage[] = [
      { role: "user", content: "просто текст" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "строковый результат" }] },
    ];
    expect(pruneStaleImages(convo, 1)).toBe(0);
    expect(convo[0]!.content).toBe("просто текст");
  });

  it("keep=0 вырезает все изображения", () => {
    const convo = [shotMsg("a"), shotMsg("b")];
    expect(pruneStaleImages(convo, 0)).toBe(2);
    expect(imagesIn(convo)).toEqual([]);
  });
});

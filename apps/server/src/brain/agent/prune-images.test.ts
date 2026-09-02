/** §скорость (зрение): тесты вырезки устаревших скриншотов из convo (prune-images.ts). */
import { describe, expect, it } from "vitest";
import type { LlmMessage, ToolResultContent } from "../../integrations/llm.js";
import { pruneStaleImages } from "./prune-images.js";
import { formatFileViewMark, SCREEN_CAPTURE_MARK } from "./image-marks.js";

/** user-ход с tool_result file_view: маркерный текст + страница документа (image-блок). */
function docMsg(id: string, path: string, page?: number, pageCount?: number): LlmMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: [
          { type: "text", text: `${formatFileViewMark({ path, page, pageCount, detail: "image/png, 1000×1400" })}\n[Это ФАЙЛ С ДИСКА…]` },
          { type: "image", source: { type: "base64", media_type: "image/png", data: `doc-${id}` } },
        ],
      },
    ],
  };
}

/** Текстовые блоки внутри tool_result сообщения (для проверки заглушек). */
function textsIn(msg: LlmMessage): string[] {
  const out: string[] = [];
  if (typeof msg.content === "string") return out;
  for (const b of msg.content) {
    if (b.type !== "tool_result" || typeof b.content === "string") continue;
    for (const c of b.content) if (c.type === "text") out.push(c.text);
  }
  return out;
}

/** user-ход с tool_result, содержащим скрин (image-блок) + текст. */
function shotMsg(id: string): LlmMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: [
          { type: "text", text: `${SCREEN_CAPTURE_MARK} (скрин ${id}):` },
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
    expect((tr.content[0] as { text: string }).text).toBe(`${SCREEN_CAPTURE_MARK} (скрин a):`);
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
            { type: "text", text: `${SCREEN_CAPTURE_MARK}:` },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "png-1" } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "png-2" } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "png-3" } },
          ],
        },
      ],
    };
    const convo = [multi, shotMsg("z")]; // multi — не последний ход (хвост защищён)
    expect(pruneStaleImages(convo, 2)).toBe(2);
    expect(imagesIn(convo)).toEqual(["png-3", "png-z"]);
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

  it("keep=0 вырезает все изображения ПРОШЛЫХ раундов; последний ход (ещё не показан модели) цел", () => {
    const convo = [shotMsg("a"), shotMsg("b"), shotMsg("c")];
    expect(pruneStaleImages(convo, 0)).toBe(2);
    expect(imagesIn(convo)).toEqual(["png-c"]);
  });

  // 🔴 Ревью 2026-09-01 (HIGH): prune зовётся сразу после convo.push(resultBlocks) — до отправки модели.
  it("картинки ПОСЛЕДНЕГО user-хода не режутся даже сверх бюджета (модель их ещё не видела); раундом позже — режутся", () => {
    const last: LlmMessage = {
      role: "user",
      content: [1, 2, 3].map((n) => ({
        type: "tool_result" as const,
        tool_use_id: `p${n}`,
        content: [
          { type: "text" as const, text: formatFileViewMark({ path: "C:\\r.pdf", page: n, pageCount: 3, detail: "x" }) },
          { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: `doc-${n}` } },
        ],
      })),
    };
    const convo: LlmMessage[] = [last];
    expect(pruneStaleImages(convo, 1, 2)).toBe(0);
    expect(imagesIn(convo)).toEqual(["doc-1", "doc-2", "doc-3"]);
    convo.push({ role: "assistant", content: "смотрю" }, docMsg("d4", "C:\\r.pdf", 4, 4));
    expect(pruneStaleImages(convo, 1, 2)).toBe(2); // теперь старшие две страницы свёрнуты
    expect(imagesIn(convo)).toEqual(["doc-3", "doc-d4"]);
  });

  it("картинка БЕЗ маркеров (MCP-инструмент) получает нейтральную заглушку, а не «сними свежий screen_capture»", () => {
    const mcp: LlmMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "m", content: [{ type: "text", text: "картинка из fetch" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "mcp-1" } }] }],
    };
    const convo = [mcp, shotMsg("a")];
    expect(pruneStaleImages(convo, 0)).toBe(1);
    const stub = textsIn(convo[0]!).at(-1)!;
    expect(stub).toContain("тем же инструментом");
    expect(stub).not.toMatch(/screen_capture|устарел/u);
  });
});

// §3.9 попутная правка честности: страница ДОКУМЕНТА (file_view) не устаревает — свой бюджет и своя
// честная заглушка; подписать ей «скриншот устарел — сними свежий screen_capture» было бы ложью.
describe("pruneStaleImages — документы (file_view) отдельно от скриншотов", () => {
  it("смешанный convo: скрины режутся по keep, документы по keepDocs, заглушки РАЗНЫЕ", () => {
    const convo = [
      shotMsg("a"),
      docMsg("d1", "C:\\docs\\отчёт.pdf", 1, 7),
      shotMsg("b"),
      docMsg("d2", "C:\\docs\\отчёт.pdf", 2, 7),
      shotMsg("c"),
      docMsg("d3", "C:\\docs\\фото.jpg"),
    ];
    expect(pruneStaleImages(convo, 1, 2)).toBe(3); // 2 скрина (a,b) + 1 документ (d1)
    expect(imagesIn(convo)).toEqual(["doc-d2", "png-c", "doc-d3"]);
    // документ: честная заглушка с путём и страницей, БЕЗ слов про устаревший скриншот
    const docStub = textsIn(convo[1]!).at(-1)!;
    expect(docStub).toContain("НЕ устарела");
    expect(docStub).toContain("отчёт.pdf");
    expect(docStub).toContain("стр. 1");
    expect(docStub).toContain("page:1");
    expect(docStub).not.toMatch(/устарел и вырезан|screen_capture/u);
    // скрин: прежняя заглушка «устарел»
    const shotStub = textsIn(convo[0]!).at(-1)!;
    expect(shotStub).toContain("устарел");
    expect(shotStub).not.toContain("НЕ устарела");
    // маркерный текст документа цел — модель по-прежнему знает, что за файл тут был
    expect(textsIn(convo[1]!)[0]).toContain("[file_view]");
  });

  it("keepDocs по умолчанию 2: три страницы → старшая свёрнута, скрины не считаются", () => {
    const convo = [docMsg("d1", "C:\\a.pdf", 1, 3), docMsg("d2", "C:\\a.pdf", 2, 3), docMsg("d3", "C:\\a.pdf", 3, 3)];
    expect(pruneStaleImages(convo, 1)).toBe(1);
    expect(imagesIn(convo)).toEqual(["doc-d2", "doc-d3"]);
  });

  it("картинка без страницы (jpg) → заглушка без «стр.», вызов file_view только с path", () => {
    const convo = [docMsg("d1", "C:\\pics\\a.jpg"), docMsg("d2", "C:\\pics\\b.jpg")];
    expect(pruneStaleImages(convo, 1, 1)).toBe(1);
    const stub = textsIn(convo[0]!).at(-1)!;
    expect(stub).toContain('file_view{path:"C:\\\\pics\\\\a.jpg"}');
    expect(stub).not.toContain("стр.");
  });

  it("маркер учитывается ТОЛЬКО внутри своего tool_result: соседний скрин в том же user-ходе остаётся скрином", () => {
    const mixed: LlmMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "doc",
          content: [
            { type: "text", text: formatFileViewMark({ path: "C:\\a.pdf", page: 1, pageCount: 1, detail: "x" }) },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "doc-1" } },
          ],
        },
        {
          type: "tool_result",
          tool_use_id: "shot",
          content: [
            { type: "text", text: "Снимок рабочего экрана:" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "png-1" } },
          ],
        },
      ],
    };
    const convo = [mixed, shotMsg("b")];
    // keep=1 → скрин png-1 (старший из двух скринов) режется; документ (единственный, keepDocs=2) — нет.
    expect(pruneStaleImages(convo, 1, 2)).toBe(1);
    expect(imagesIn(convo)).toEqual(["doc-1", "png-b"]);
  });

  it("идемпотентна и для документов: повторный вызов ничего не режет", () => {
    const convo = [docMsg("d1", "C:\\a.pdf", 1, 2), docMsg("d2", "C:\\a.pdf", 2, 2)];
    expect(pruneStaleImages(convo, 1, 1)).toBe(1);
    expect(pruneStaleImages(convo, 1, 1)).toBe(0);
  });
});

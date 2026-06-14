import { describe, expect, it } from "vitest";
import { extractReadable, parseBraveResults, stripHtml } from "./web.js";

describe("parseBraveResults (§12)", () => {
  it("извлекает результаты в SearchHit[]", () => {
    const json = {
      web: {
        results: [
          { title: "Anthropic", url: "https://anthropic.com", description: "AI <b>safety</b>" },
          { title: "Claude", url: "https://claude.ai", description: "ассистент" },
        ],
      },
    };
    const hits = parseBraveResults(json, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ title: "Anthropic", url: "https://anthropic.com", snippet: "AI safety" });
  });

  it("уважает limit и пропускает записи без url", () => {
    const json = { web: { results: [{ title: "a", url: "u1", description: "" }, { title: "b" }] } };
    expect(parseBraveResults(json, 1)).toHaveLength(1);
  });

  it("мусор → []", () => {
    expect(parseBraveResults(null)).toEqual([]);
    expect(parseBraveResults({})).toEqual([]);
  });
});

describe("extractReadable / stripHtml (§12)", () => {
  it("вырезает script/style и достаёт title + текст", () => {
    const html =
      "<html><head><title>Заголовок</title><style>.x{}</style></head>" +
      "<body><script>alert(1)</script><p>Привет, мир.</p></body></html>";
    const page = extractReadable(html, "https://e.com");
    expect(page.title).toBe("Заголовок");
    expect(page.text).toContain("Привет, мир.");
    expect(page.text).not.toContain("alert");
    expect(page.text).not.toContain("{}");
    expect(page.url).toBe("https://e.com");
  });

  it("stripHtml декодирует сущности и схлопывает пробелы", () => {
    expect(stripHtml("<p>a&amp;b</p>   <span>c</span>")).toBe("a&b c");
  });
});

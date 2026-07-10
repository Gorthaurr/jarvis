import { describe, expect, it } from "vitest";
import { extractReadable, parseBraveResults, parseDuckDuckGoLite, stripHtml } from "./web.js";

describe("parseDuckDuckGoLite (§12 keyless-фолбэк)", () => {
  const html = `
    <table>
    <tr><td><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fru.wikipedia.org%2Fwiki%2FX&rut=aa" class='result-link'>Заголовок <b>один</b></a></td></tr>
    <tr><td>&nbsp;</td><td class='result-snippet'> Сниппет <b>один</b> текст </td></tr>
    <tr><td><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fhabr.com%2Farticle&rut=bb" class='result-link'>Заголовок два</a></td></tr>
    <tr><td>&nbsp;</td><td class='result-snippet'> Сниппет два </td></tr>
    </table>`;

  it("извлекает реальный url из uddg, заголовок и сниппет", () => {
    const hits = parseDuckDuckGoLite(html, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: "Заголовок один",
      url: "https://ru.wikipedia.org/wiki/X",
      snippet: "Сниппет один текст",
    });
    expect(hits[1]!.url).toBe("https://habr.com/article");
  });

  it("уважает limit и игнорирует не-http ссылки", () => {
    expect(parseDuckDuckGoLite(html, 1)).toHaveLength(1);
    expect(parseDuckDuckGoLite(`<a href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)" class='result-link'>x</a>`)).toHaveLength(0);
  });
});

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

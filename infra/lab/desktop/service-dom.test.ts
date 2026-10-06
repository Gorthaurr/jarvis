import { describe, expect, it } from "vitest";
import { find, innerText, isVisible, looksLikeHtml, parseHtml, titleOf } from "./service-dom.js";
import { queryAll } from "./service-dom-select.js";

const doc = `<!doctype html><html><head><title>Тест &amp; проба</title><style>.x{display:none}</style></head>
<body><!-- коммент --><h1>Заголовок</h1><p>Раз<br>два &laquo;три&raquo; &#33;<p>Второй абзац
<ul><li>один<li>два</ul>
<div hidden>СКРЫТО</div><div style="display: none">ТОЖЕ</div><script>var a = "<b>не тег</b>";</script>
<form id="f1"><input name="q" placeholder="Поиск"><input type="hidden" name="t" value="1"><button type="submit">Найти</button></form>
<a class="btn big" href="/next?a=1&amp;b=2">Далее</a> a < b</body></html>`;

describe("разбор HTML", () => {
  const root = parseHtml(doc);

  it("заголовок с сущностями, скрипт и стили не текст страницы, скрытое не читается", () => {
    expect(titleOf(root)).toBe("Тест & проба");
    const text = innerText(find(root, (n) => n.tag === "body")!);
    expect(text).toContain("Заголовок");
    expect(text).toContain("два «три» !");
    expect(text).not.toMatch(/СКРЫТО|ТОЖЕ|не тег|display/u);
    expect(text).toContain("a < b");
  });

  it("неявные закрытия: <p> и <li> без закрывающих не вкладываются друг в друга", () => {
    expect(queryAll(root, "li").map((n) => innerText(n))).toEqual(["один", "два"]);
    expect(queryAll(root, "p")).toHaveLength(2);
    expect(queryAll(root, "p p")).toHaveLength(0);
  });

  it("атрибуты: сущности в значении, boolean, видимость (hidden, display:none, type=hidden)", () => {
    const link = queryAll(root, "a.btn.big")[0]!;
    expect(link.attrs.href).toBe("/next?a=1&b=2");
    expect(queryAll(root, "div").map(isVisible)).toEqual([false, false]);
    expect(queryAll(root, "input[type=hidden]").map(isVisible)).toEqual([false]);
    expect(isVisible(queryAll(root, "input[name=q]")[0]!)).toBe(true);
  });

  it("селекторы: #id, атрибут, цепочки >, потомок, :nth-of-type, список", () => {
    expect(queryAll(root, "#f1 > button")).toHaveLength(1);
    expect(queryAll(root, 'input[placeholder="Поиск"]')).toHaveLength(1);
    expect(queryAll(root, "form input:nth-of-type(2)")[0]?.attrs.name).toBe("t");
    expect(queryAll(root, "h1, a").map((n) => n.tag)).toEqual(["h1", "a"]);
    expect(queryAll(root, "body > form > button")).toHaveLength(1);
    expect(queryAll(root, "html > button")).toHaveLength(0);
  });

  it("экранированный селектор из inspect находит свой элемент", () => {
    const r = parseHtml(`<button aria-label='Say "hi"'>x</button>`);
    expect(queryAll(r, 'button[aria-label="Say \\"hi\\""]')).toHaveLength(1);
  });

  it("неподдержанный синтаксис — ошибка, а не «ничего не найдено»", () => {
    expect(() => queryAll(root, "a:hover")).toThrow(/не поддержан/u);
    expect(() => queryAll(root, "a + b")).toThrow(/не поддержан/u);
  });

  it("looksLikeHtml отличает разметку от простого текста", () => {
    expect(looksLikeHtml("<html><body>x</body></html>")).toBe(true);
    expect(looksLikeHtml("просто текст, 1 < 2")).toBe(false);
  });
});

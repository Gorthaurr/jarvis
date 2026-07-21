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

  it("ревью-фикс #1: adversarial DDG-ответ (скомпрометированный/MITM) НЕ вешает парс (ReDoS)", () => {
    // Прежние `[^>]+`/`[\s\S]*?` давали O(n²) на потоке `<a `/`<td ` без '>' → синхронный event-loop висел минуты.
    const cases = [
      "<a ".repeat(500_000), // link-флуд без '>' и href
      "<td ".repeat(500_000), // snippet-флуд
      `<a href="//x/?uddg=`.repeat(100_000), // частичные ссылки без закрытия
    ];
    for (const adversarial of cases) {
      const t0 = Date.now();
      const hits = parseDuckDuckGoLite(adversarial, 5);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(Array.isArray(hits)).toBe(true);
    }
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

  it("ревью-фикс #6: числовые + именованные сущности декодируются (RU-типографика, numeric-кириллица)", () => {
    expect(stripHtml("<p>&laquo;цитата&raquo; &mdash; тире</p>")).toBe("«цитата» — тире");
    expect(stripHtml("<p>&#171;A&#187; &#8212; &#1055;ривет</p>")).toBe("«A» — Привет"); // hex/dec + кириллица
    expect(stripHtml("<p>&#x41;&#x42;&hellip;</p>")).toBe("AB…"); // hex
    expect(stripHtml("<p>Tom &amp; Jerry &unknownent; &amp</p>")).toBe("Tom & Jerry &unknownent; &amp"); // неизвестное/битое — как есть
  });

  it("ревью-фикс #6b: <title> берётся из очищенного html (не из комментария/скрипта)", () => {
    const fromComment = extractReadable("<head><!-- <title>Плейсхолдер</title> --><title>Настоящий</title></head><body><p>x</p></body>");
    expect(fromComment.title).toBe("Настоящий");
    const fromScript = extractReadable(`<head><script>var s='<title>ФЕЙК</title>'</script><title>Реальный</title></head><body><p>y</p></body>`);
    expect(fromScript.title).toBe("Реальный");
  });

  it("ревью-фикс #6c: <!--> abrupt-пустой комментарий не съедает контент до конца", () => {
    const page = extractReadable("<!--><p>Контент после пустого комментария уцелел.</p>");
    expect(page.text).toContain("Контент после пустого комментария");
  });

  it("ревью-фикс #7: --!> (HTML5 comment-end-bang) закрывает комментарий (не ест контент)", () => {
    const page = extractReadable("<!-- nav config --!><p>РЕАЛЬНЫЙ КОНТЕНТ должен уцелеть.</p><!-- footer -->");
    expect(page.text).toContain("РЕАЛЬНЫЙ КОНТЕНТ");
  });

  it("ревью-фикс #8: литеральный </main> в <textarea> (RCDATA) не закрывает доминирующий <main> раньше", () => {
    const big = "Большой реальный абзац основного контента урока для превышения половины страницы. ".repeat(3);
    const html =
      `<body><main><h1>Урок</h1><p>${big}</p>` +
      `<textarea>вставьте так: </main></textarea>` + // литеральный </main> внутри RCDATA
      `<p>КОНЕЦ УРОКА — важный финальный абзац после редактора.</p></main></body>`;
    const page = extractReadable(html);
    expect(page.text).toContain("Большой реальный абзац");
    expect(page.text).toContain("КОНЕЦ УРОКА"); // хвост после textarea не потерян
  });

  it("ревью-фикс #7b: <script>/<style> литерал в <title> (RCDATA) не крадёт контент боди", () => {
    const html = "<head><title>Про тег <script> в HTML</title></head><body><p>ТЕКСТ БОДИ уцелел.</p><script>evil()</script></body>";
    const page = extractReadable(html);
    expect(page.title).toContain("Про тег"); // title цел
    expect(page.text).toContain("ТЕКСТ БОДИ"); // боди не удалён спариванием title-<script> с боди-</script>
    expect(page.text).not.toContain("evil"); // настоящий скрипт вырезан
  });

  // План web-search 2026-07-21: извлечение основного блока (меньше context-rot). nav/footer/aside
  // исключаются НЕ блок-вырезом (опасен на битом HTML — цеплял чужой </tag>), а тем, что они ВНЕ <main>.
  it("исключает nav/footer вне <main> через извлечение основного блока", () => {
    const body = "Основной текст статьи с достаточным объёмом для порога доминирования блока. ".repeat(4);
    const html =
      "<body><nav>Главная Контакты Вход</nav>" +
      `<main><p>${body}</p></main>` +
      "<footer>© 2026 Копирайт политика куки</footer></body>";
    const page = extractReadable(html);
    expect(page.text).toContain("Основной текст статьи");
    expect(page.text).not.toContain("Контакты"); // вне <main> → исключено
    expect(page.text).not.toContain("Копирайт");
  });

  it("ревью-фикс #2: незакрытый <nav> (закрыт </div>) НЕ удаляет статью в <main> (кросс-пейринг)", () => {
    const body = "Длинная реальная статья, которую нельзя молча потерять из-за битой разметки навигации. ".repeat(4);
    const html =
      `<div><nav class="top"><a>Home</a></div>` + // <nav> закрыт </div>, его </nav> отсутствует
      `<main><p>${body}</p></main>` +
      `<nav class="bottom"><a>Low</a></nav></body>`;
    const page = extractReadable(html);
    expect(page.text).toContain("Длинная реальная статья"); // статья ЦЕЛА (прежний блок-вырез стирал её)
  });

  it("ревью-фикс #3: вложенный <article> не теряет хвост внешней статьи (depth-парсинг)", () => {
    const intro = "Вступление внешней статьи с достаточным объёмом полезного текста для порога. ";
    const concl = "Заключение внешней статьи после вложенной вставки — не должно потеряться никак.";
    const html =
      `<body><article><p>${intro}</p>` +
      `<article class="callout"><p>Вложенная врезка со ссылкой.</p></article>` +
      `<p>${concl}</p></article></body>`;
    const page = extractReadable(html);
    expect(page.text).toContain("Вступление внешней"); // до вложенной
    expect(page.text).toContain("Заключение внешней"); // ПОСЛЕ вложенной — хвост цел
  });

  it("ревью-фикс #2: дефисный кастом-элемент <article-nav> не крадёт последующий <article>", () => {
    const a = "Первая настоящая статья с достаточным объёмом полезного текста для дела. ".repeat(2);
    const html =
      `<body><article><p>${a}</p></article>` +
      `<article-nav><a>меню виджета</a></article-nav>` + // валидный web-component, НЕ <article>
      `<article><p>Вторая настоящая статья тоже должна остаться в выдаче.</p></article></body>`;
    const page = extractReadable(html);
    expect(page.text).toContain("Первая настоящая статья");
    expect(page.text).toContain("Вторая настоящая статья"); // не потеряна из-за <article-nav>
  });

  it("ревью-фикс #5: raw-открытие в комментарии не крадёт контент до реального </script> (единый проход)", () => {
    // <!-- ... <script> ... --> — открытие скрипта в ТЕКСТЕ комментария; не должно спариться с поздним </script>.
    const html =
      "<!-- TODO: вернуть <script src=old.js> позже -->" +
      "<p>ВАЖНЫЙ КОНТЕНТ страницы который нельзя терять.</p>" +
      "<script>analytics()</script>";
    const page = extractReadable(html);
    expect(page.text).toContain("ВАЖНЫЙ КОНТЕНТ");
    expect(page.text).not.toContain("analytics");
  });

  it("ревью-фикс #5b: <!-- внутри <script> не съедает страницу до конца (обратное направление)", () => {
    // <script>var x="<!--";</script> — `<!--` внутри строки скрипта; не должно съесть до EOF.
    const html = `<script>var x = "<!--";</script><p>Реальный абзац после скрипта уцелел.</p>`;
    const page = extractReadable(html);
    expect(page.text).toContain("Реальный абзац после скрипта");
    expect(page.text).not.toContain("var x");
  });

  it("ревью-фикс #4: незакрытый хвостовой <article> при доминирующей закрытой — не теряется (фолбэк на тело)", () => {
    const closed = "Первая закрытая статья, доминирующая по объёму текста на странице бесспорно. ".repeat(3);
    const unclosed = "Вторая статья без закрывающего тега — её реальный текст нельзя молча потерять. ".repeat(2);
    // closed сбалансирована и >50% тела; unclosed НЕ закрыта → blockInners.complete=false → фолбэк на всё тело.
    const html = `<body><article><p>${closed}</p></article><article><p>${unclosed}</p></body>`;
    const page = extractReadable(html);
    expect(page.text).toContain("Первая закрытая статья");
    expect(page.text).toContain("Вторая статья без закрывающего"); // не выпала из-за незакрытости
  });

  it("ревью-фикс #3b: дефисный <style-guide> не принимается за <style> (не стирает контент)", () => {
    const html =
      "<body><p>Вступительный абзац сохраняется.</p>" +
      "<style-guide>Реальная документация в кастом-элементе тоже важна.</style-guide>" +
      "<p>Ещё один реальный абзац должен уцелеть.</p>" +
      "<style>.x{color:red}</style><p>Финальный абзац.</p></body>";
    const page = extractReadable(html);
    expect(page.text).toContain("Реальная документация"); // <style-guide> не вырезан как <style>
    expect(page.text).toContain("Ещё один реальный абзац"); // контент между не удалён кросс-пейрингом
    expect(page.text).toContain("Финальный абзац");
    expect(page.text).not.toContain("color:red"); // настоящий <style> всё же вырезан
  });

  it("предпочитает содержательный <main> (шум вне main отбрасывается)", () => {
    const filler = "Содержательный абзац основного контента. ".repeat(8); // >200 симв текста
    const html =
      `<body><div class="sidebar">Меню Профиль Настройки Выход</div>` +
      `<main><h1>Статья</h1><p>${filler}</p></main>` +
      `<div class="promo">Купите подписку прямо сейчас</div></body>`;
    const page = extractReadable(html);
    expect(page.text).toContain("Содержательный абзац");
    expect(page.text).toContain("Статья");
    expect(page.text).not.toContain("Профиль");
    expect(page.text).not.toContain("Купите подписку");
  });

  it("КОНКАТЕНИРУЕТ все <article> без <main> (лента/тред — не теряем посты; ревью-фикс content-loss)", () => {
    // Тред/лента: каждая статья — нужный контент. Прежний «крупнейший» молча выбрасывал остальные (ложная полнота).
    const p = (n: number) => `Пост номер ${n} с достаточным объёмом полезного текста для порога. `.repeat(2);
    const html =
      `<body><article><p>${p(1)}</p></article>` +
      `<article><p>${p(2)}</p></article>` +
      `<article><p>${p(3)}</p></article></body>`;
    const page = extractReadable(html);
    expect(page.text).toContain("Пост номер 1");
    expect(page.text).toContain("Пост номер 2");
    expect(page.text).toContain("Пост номер 3"); // ВСЕ три, не один
  });

  it("промо-<article> НЕ перебивает большой <section> без <main> → берётся всё тело (ревью-фикс #6)", () => {
    const prose = "Реальная длинная проза статьи в секции без семантической разметки main. ".repeat(12);
    const html =
      `<body><section><h1>Заголовок</h1><p>${prose}</p></section>` +
      `<article class="promo"><p>Подпишитесь на рассылку и получите скидку прямо сейчас сегодня.</p></article></body>`;
    const page = extractReadable(html);
    // promo-article (~65 симв) < 50% текста страницы → fraction-гард отвергает → всё тело: проза видна.
    expect(page.text).toContain("Реальная длинная проза");
    expect(page.text).toContain("Подпишитесь"); // тело целиком, промо не теряется тоже
  });

  it("ReDoS-санити: adversarial 2MB+ извлекается БЫСТРО (линейно; ревью-фиксы ReDoS)", () => {
    // Прежние O(n²): (а) ленивый [\\s\\S]*?</tag> на незакрытых тегах; (б) /<[^>]+>/g на плотных `<`.
    // Оба покрыты: незакрытые теги + чистый `<`-флуд + незакрытый комментарий. Линейный путь = миллисекунды.
    const cases = [
      "<article>".repeat(200_000) + "<nav>".repeat(200_000), // незакрытые закрытые теги
      "<".repeat(600_000), // `<`-флуд без `>` (валил старый stripHtml /<[^>]+>/g)
      "<3 ".repeat(200_000), // спам-эмотикон: много `<`, редкие `>`
      "<!--".repeat(150_000), // незакрытые комментарии
      // Open-ПРЕФИКС-флуд БЕЗ '>' — валил open-regex `<tag\b[^>]*>` (O(n²) на интерпретаторном пути Irregexp).
      // Ровно тот класс, что прошлый тест пропускал. Покрывает stripBlocks/blockInners/extractTitle.
      "<script".repeat(250_000), // script/style/noscript-контейнеры (stripBlocks)
      "<article".repeat(250_000), // <article> (blockInners)
      "<main".repeat(300_000), // <main> (blockInners firstOnly)
      "<title".repeat(250_000), // <title> (extractTitle)
    ];
    for (const adversarial of cases) {
      const t0 = Date.now();
      const page = extractReadable(adversarial);
      expect(Date.now() - t0).toBeLessThan(1500); // на O(n²) — десятки секунд/минуты
      expect(typeof page.text).toBe("string"); // не падает
    }
  });

  it("нет разметки основного блока (или он мал) → берёт всю очищенную страницу (не теряем контент)", () => {
    const html = "<body><main><p>крошка</p></main><p>Реальный контент без семантической разметки страницы.</p></body>";
    // <main> мал (<200 симв) → фолбэк на всё тело: виден и main-текст, и остальной контент.
    const page = extractReadable(html);
    expect(page.text).toContain("Реальный контент без семантической разметки");
    expect(page.text).toContain("крошка");
  });
});

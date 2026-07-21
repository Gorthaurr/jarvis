/**
 * Веб-знания (§12): web.search (Brave) + web.fetch (readability-извлечение).
 *
 * Server-side инструменты мозга — Q&A никогда не гоняет GUI-браузер юзера (§12).
 * Сеть через глобальный fetch (Node 22). Без BRAVE_SEARCH_API_KEY поиск отдаёт [];
 * fetch работает без ключа (нужна лишь сеть). Парсеры — чистые, тестируются без сети.
 */
import { type CacheStats, type Logger, TtlCache, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("web");

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchedPage {
  url: string;
  title: string;
  /** Очищенный читаемый текст (без навигации/скриптов/стилей). */
  text: string;
}

export interface IWebProvider {
  search(query: string, limit?: number): Promise<SearchHit[]>;
  fetch(url: string): Promise<FetchedPage | null>;
  readonly live: boolean;
}

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
/** Keyless-фолбэк поиска (§12): DuckDuckGo Lite — работает БЕЗ ключа (нужна лишь сеть). */
const DDG_LITE_URL = "https://lite.duckduckgo.com/lite/";
const SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Таймаут сетевых вызовов мозга (§12): не вешать голосовой ответ на медленном сайте. */
const WEB_TIMEOUT_MS = 8_000;
/** Жёсткий лимит вычитываемого HTML (защита от гигантских страниц до slice). */
const MAX_HTML_BYTES = 2_000_000;

/**
 * SSRF-защита (§14): URL для web.fetch приходит от LLM (tool-use). Не пускаем модель
 * читать внутреннюю сеть/метаданные облака/localhost и не-http(s) схемы.
 */
export function isFetchUrlAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  // IPv6-литерал URL.hostname приходит В СКОБКАХ ("[::1]") — снимаем перед проверкой.
  const v6 = host.startsWith("[") && host.endsWith("]");
  const h = v6 ? host.slice(1, -1) : host;
  if (v6) {
    if (h === "::1" || h === "::") return false; // loopback / unspecified
    if (/^(?:fc|fd|fe80)/.test(h)) return false; // ULA / link-local
    // IPv4-mapped: ::ffff:127.0.0.1 (dotted) и ::ffff:7f00:1 (hex).
    const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
    if (mapped && isPrivateIpv4(mapped[1]!)) return false;
    if (/::ffff:(?:7f|0a|a9fe|c0a8)/.test(h)) return false; // hex 127/10/169.254/192.168
    return true;
  }
  if (isPrivateIpv4(h) || /^0\./.test(h)) return false;
  return true;
}

/** Приватные/служебные IPv4-диапазоны (RFC1918 + loopback + link-local). */
function isPrivateIpv4(host: string): boolean {
  if (/^(?:127\.|10\.|169\.254\.|192\.168\.)/.test(host)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/** Прочитать тело с жёстким лимитом байт ПОТОКОВО (не буферизуя весь ответ в память). */
async function readCappedText(resp: Response, maxBytes: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return (await resp.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total >= maxBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Разобрать ответ Brave Search в SearchHit[] (чистая функция). */
export function parseBraveResults(json: unknown, limit = 5): SearchHit[] {
  if (typeof json !== "object" || json === null) return [];
  const results = (json as { web?: { results?: unknown[] } }).web?.results;
  if (!Array.isArray(results)) return [];
  const hits: SearchHit[] = [];
  for (const r of results) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as { title?: string; url?: string; description?: string };
    if (!o.url) continue;
    hits.push({
      title: (o.title ?? "").trim(),
      url: o.url,
      snippet: stripHtml(o.description ?? "").trim(),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * Разобрать выдачу DuckDuckGo Lite в SearchHit[] (чистая функция, тестируется без сети).
 * Реальный URL лежит в параметре `uddg=<urlencoded>` редирект-ссылки; сниппет — в соседней ячейке.
 */
export function parseDuckDuckGoLite(html: string, limit = 5): SearchHit[] {
  const links: { url: string; title: string }[] = [];
  // `[^<>]` (не `[^>]`) в атрибутах + ОГРАНИЧЕННЫЙ `[\s\S]{0,4000}?` в контенте: иначе на adversarial-теле от
  // (скомпрометированного/MITM) lite.duckduckgo.com `[^>]+`/`[\s\S]*?` давали O(n²)-скан → синхронный парс вешал
  // event-loop на минуты (тот же класс ReDoS, что в extractReadable — ревью-находка; дефолтный keyless-путь).
  const linkRe = /<a[^<>]+href="([^"<>]*uddg=[^"<>]+)"[^<>]*class=['"]result-link['"][^<>]*>([\s\S]{0,4000}?)<\/a>/gi;
  for (let m = linkRe.exec(html); m !== null; m = linkRe.exec(html)) {
    const uddg = /[?&]uddg=([^&"]+)/.exec(m[1]!);
    if (!uddg) continue;
    let url: string;
    try {
      url = decodeURIComponent(uddg[1]!);
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(url)) continue;
    links.push({ url, title: stripHtml(m[2]!) });
  }
  const snippets: string[] = [];
  const snipRe = /<td[^<>]*class=['"]result-snippet['"][^<>]*>([\s\S]{0,4000}?)<\/td>/gi; // [^<>]+bounded — ReDoS-safe
  for (let m = snipRe.exec(html); m !== null; m = snipRe.exec(html)) snippets.push(stripHtml(m[1]!));
  const hits: SearchHit[] = [];
  for (let i = 0; i < links.length && hits.length < limit; i += 1) {
    hits.push({ title: links[i]!.title, url: links[i]!.url, snippet: snippets[i] ?? "" });
  }
  return hits;
}

/**
 * Извлечение читаемого текста из HTML (чистая функция).
 * Улучшено (2026-07-21, план web-search; 2 раунда адверс-ревью до нуля): раньше слепой strip тегов тащил в
 * LLM ВЕСЬ boilerplate → context-rot + лишние токены. Теперь фокус на контенте даёт извлечение ОСНОВНОГО
 * блока: `<main>` целиком, иначе — КОНКАТЕНАЦИЯ всех `<article>` (тред/лента/хоумпейдж — берём ВСЕ статьи, не
 * «крупнейшую»: тихий выброс = ложная полнота), НО лишь если блок «доминирует» (≥50% текста страницы — иначе
 * контент вне блока, напр. промо-`<article>` при большом `<section>`, → берём всё тело). Извлечение <main>/
 * <article> само исключает окружающие nav/footer/sidebar (они ВНЕ блока) — поэтому их НЕ режем отдельно
 * (блок-вырезание nav на битом HTML цепляло чужой `</nav>` и УДАЛЯЛО статью между — ревью-находка content-loss).
 * Комментарии и script/style/noscript (их «нутро» — код, не текст; stripHtml оставил бы его строкой) убираем
 * ЕДИНЫМ левонаправленным проходом `stripRawBlocks`: кто начинается раньше (`<!--` или raw-открытие), тот и
 * обрабатывается как целое до своего закрытия. Двухпроходный blocks-then-comments/наоборот НЕ покрывал ОБА
 * направления (`<!-- <script> -->` цеплял реальный `</script>`; `<script>"<!--"` ел до EOF) — ревью-находка.
 * ⚠️ Всё ЛИНЕЙНО (O(n): indexOf/charCode-скан + depth-парсинг, БЕЗ ленивых `[\s\S]*?` и `/<[^>]+>/`, которые
 * на 2MB `<`-плотного/незакрытого входа давали O(n²) и вешали синхронный парс = весь event-loop; сетевой
 * таймаут не спасал — ревью-находка ReDoS). Не полный Readability (без jsdom — осознанно, single-user);
 * role="main"-div без тега <main> не выделяется → фолбэк на всё тело (контент не теряется). Open-теги матчатся
 * `<tag(?=[\s/>])[^<>]*>` ([^<>]*, НЕ [^>]*) — класс стопается на '<', поток `<tag`-префиксов без '>' фейлит
 * мгновенно (O(n), не O(n²)); lookahead `(?=[\s/>])` (не `\b`) не путает `<article-nav>` c `<article>`.
 */
export function extractReadable(html: string, url = ""): FetchedPage {
  const cleaned = stripRawBlocks(html); // убирает script/style/noscript/комментарии (и <title> ВНУТРИ них)
  const title = extractTitle(cleaned); // из cleaned: <title> в комментарии/скрипте не подменяет настоящий (ревью-находка)
  const bodyText = stripHtml(cleaned);
  const block = pickMainContent(cleaned, bodyText.length);
  const text = block !== null ? stripHtml(block) : bodyText; // тело не strip'аем второй раз (была ревью-жалоба на 2 прохода)
  return { url, title: decodeEntities(title), text };
}

/** Контейнеры, чьё нутро — НЕ текст (код/стили) → режем ЦЕЛИКОМ. nav/footer/aside/svg/header/form НЕ трогаем. */
const RAW_BLOCK_TAGS = ["script", "style", "noscript"] as const;
const MAIN_BLOCK_MIN_CHARS = 200; // блок «содержателен», иначе не выделяем
const MAIN_BLOCK_MIN_FRACTION = 0.5; // …и составляет БОЛЬШИНСТВО текста страницы (иначе контент вне блока — не теряем)

/**
 * Выбрать основной контентный блок: `<main>` (обычно один) либо КОНКАТЕНАЦИЯ всех `<article>`. null, если
 * разметки нет ЛИБО блок не «доминирует» (≥200 симв текста И ≥50% текста всей страницы `bodyLen`) — тогда
 * вызывающий берёт всю очищенную страницу. Конкатенация всех статей + порог доли закрывают тихую потерю
 * (лента/тред — все посты; промо-`<article>` не перебивает большой `<section>`): выброс контента = ложная полнота.
 */
function pickMainContent(html: string, bodyLen: number): string | null {
  if (bodyLen === 0) return null;
  const dominant = (candidate: string): boolean => {
    const n = stripHtml(candidate).length;
    return n >= MAIN_BLOCK_MIN_CHARS && n >= MAIN_BLOCK_MIN_FRACTION * bodyLen;
  };
  const mainRes = blockInners(html, "main", true);
  const main = mainRes.inners[0];
  if (main !== undefined && mainRes.complete && dominant(main)) return main;
  // complete=false → скан наткнулся на НЕсбалансированный `<article>` (незакрытый/усечённый по 2MB-капу): часть
  // статей не захвачена, но их текст ВХОДИТ в bodyLen → доминирующая ЗАХВАЧЕННАЯ статья прошла бы gate, а
  // незахваченный хвост молча выпал (ревью-находка). Частичному набору НЕ доверяем → фолбэк на всё тело (там ВСЁ).
  const artRes = blockInners(html, "article", false);
  if (artRes.complete && artRes.inners.length > 0) {
    const combined = artRes.inners.join("\n\n");
    if (dominant(combined)) return combined;
  }
  return null;
}

/**
 * Внутренний HTML блоков `<tag>…</tag>` — ЛИНЕЙНО, с учётом ВЛОЖЕННОСТИ того же тега (depth): для внешнего
 * `<article>` находим ПАРНОЕ закрытие, а не первое попавшееся (иначе хвост после вложенного `</article>`
 * терялся — ревью-находка). Токен-скан идёт монотонно-вперёд (lastIndex за весь блок) → O(n). firstOnly — первый.
 * Возвращает `complete=false`, если наткнулись на НЕсбалансированный открывающий тег (незакрытый/усечённый) —
 * тогда набор ЧАСТИЧНЫЙ, вызывающий не доверяет ему и берёт всё тело (иначе незахваченный хвост молча выпал бы).
 */
function blockInners(html: string, tag: string, firstOnly: boolean): { inners: string[]; complete: boolean } {
  // Имя тега якорим lookahead'ом `(?=[\s/>])` (НЕ `\b`): `\b` срабатывает и на дефис → `<article-nav>` матчился
  // как `<article>`, а `</article-nav>` — нет → дисбаланс depth молча терял след. `<article>` (ревью-находка).
  // `(?=[\s/>])` требует после имени пробел/`/`/`>` → дефисные кастом-элементы и `<maintenance>` отсеяны.
  // `[^<>]*` (НЕ `[^>]*`): стопается на '<' → поток `<tag`-префиксов без '>' фейлит мгновенно (O(n), не O(n²)).
  const openRe = new RegExp(`<${tag}(?=[\\s/>])[^<>]*>`, "gi");
  const tokenRe = new RegExp(`<${tag}(?=[\\s/>])[^<>]*>|</${tag}\\s*>`, "gi"); // открытия И закрытия того же тега
  const inners: string[] = [];
  for (let m = openRe.exec(html); m !== null; m = openRe.exec(html)) {
    const contentStart = openRe.lastIndex;
    tokenRe.lastIndex = contentStart;
    let depth = 1;
    let closeStart = -1;
    let afterClose = -1;
    for (let t = tokenRe.exec(html); t !== null; t = tokenRe.exec(html)) {
      if (t[0]![1] === "/") {
        depth -= 1;
        if (depth === 0) {
          closeStart = t.index;
          afterClose = tokenRe.lastIndex;
          break;
        }
      } else {
        depth += 1; // вложенное открытие того же тега
      }
    }
    if (closeStart === -1) return { inners, complete: false }; // несбалансированный → набор частичный
    inners.push(html.slice(contentStart, closeStart));
    if (firstOnly) break;
    openRe.lastIndex = afterClose; // продолжить ПОСЛЕ всего блока (вложенные учтены)
  }
  return { inners, complete: true };
}

const CH = { LT: 60, GT: 62, SLASH: 47, BANG: 33, DASH: 45 } as const;
const isWsCode = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/** Совпадает ли имя тега в позиции `pos` с `tag` (уже lowercase), регистронезависимо (без toLowerCase — Unicode-safe). */
function matchesTagName(html: string, pos: number, tag: string): boolean {
  for (let k = 0; k < tag.length; k += 1) {
    let c = html.charCodeAt(pos + k);
    if (c >= 65 && c <= 90) c += 32; // ASCII → lower
    if (c !== tag.charCodeAt(k)) return false;
  }
  return true;
}

/** RCDATA-элементы: их содержимое — ТЕКСТ (не разметка), вложенные `<script>` и т.п. НЕ интерпретируются. */
const RCDATA_TAGS = ["title", "textarea"] as const;

/** Открытие какого из `tags` начинается в позиции `<` (lt)? Требует границу [\s/>] после имени. null, если ни один. */
function matchOpenFrom(html: string, lt: number, tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (matchesTagName(html, lt + 1, tag)) {
      const after = html.charCodeAt(lt + 1 + tag.length);
      if (after === CH.GT || after === CH.SLASH || isWsCode(after)) return tag;
    }
  }
  return null;
}

/**
 * Индекс ПОСЛЕ терминатора комментария (>= from), либо -1. Ищем `--` затем `>` (`-->`) или `!>` (`--!>` —
 * HTML5 comment-end-bang). Старт от lt+2 покрывает abrupt-закрытые `<!-->`/`<!--->` (терминатор перекрывает
 * дефисы опенера). Оба варианта закрытия — иначе `<!-- x --!>` считался незакрытым и ел контент (ревью-находка).
 */
function findCommentEnd(html: string, from: number): number {
  for (let p = html.indexOf("--", from); p !== -1; p = html.indexOf("--", p + 1)) {
    const c = html.charCodeAt(p + 2);
    if (c === CH.GT) return p + 3; // -->
    if (c === CH.BANG && html.charCodeAt(p + 3) === CH.GT) return p + 4; // --!>
  }
  return -1;
}

/** Диапазон закрывающего `</tag …>` (>= from): {start=индекс '<', end=индекс ПОСЛЕ '>'} либо null. Линейно. */
function findRawClose(html: string, tag: string, from: number): { start: number; end: number } | null {
  for (let p = html.indexOf("<", from); p !== -1; p = html.indexOf("<", p + 1)) {
    if (html.charCodeAt(p + 1) !== CH.SLASH || !matchesTagName(html, p + 2, tag)) continue;
    let j = p + 2 + tag.length;
    while (isWsCode(html.charCodeAt(j))) j += 1;
    if (html.charCodeAt(j) === CH.GT) return { start: p, end: j + 1 };
  }
  return null;
}

/** Экранировать угловые скобки: `<`→`&lt;`, `>`→`&gt;` (RCDATA-нутро — ТЕКСТ; так его не перечитают как разметку). */
function escapeAngles(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * ЕДИНЫМ левонаправленным проходом убрать HTML-комментарии И содержимое script/style/noscript. На каждом `<`
 * решаем, что здесь начинается: комментарий `<!--` / raw-открытие / RCDATA-открытие — и обрабатываем это как
 * ЦЕЛОЕ до его закрытия. Поэтому `<!-- <script> -->` (raw-тег в тексте комментария) НЕ спарится с реальным
 * `</script>`, `<script>"<!--"</script>` (`<!--` внутри скрипта) не съест до EOF, а `<title>The <script></title>`
 * (RCDATA: `<script>` в титуле — литерал-текст) не спарится с боди-`</script>` — ВСЕ направления, которые
 * двухпроходный подход покрыть не мог (ревью-находки content-loss). Незакрытый комментарий/raw ест до EOF
 * (поведение HTML-парсера); незакрытое открытие без '>' оставляем как текст. Всё ЛИНЕЙНО (indexOf монотонно).
 */
function stripRawBlocks(html: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    // Комментарий `<!--` ?
    if (html.charCodeAt(lt + 1) === CH.BANG && html.charCodeAt(lt + 2) === CH.DASH && html.charCodeAt(lt + 3) === CH.DASH) {
      out += `${html.slice(i, lt)} `;
      const end = findCommentEnd(html, lt + 2); // индекс ПОСЛЕ терминатора (-->/--!>/abrupt)
      if (end === -1) break; // незакрытый комментарий — до EOF
      i = end;
      continue;
    }
    // Открытие raw-блока (script/style/noscript) — содержимое удаляем ?
    const rawTag = matchOpenFrom(html, lt, RAW_BLOCK_TAGS);
    if (rawTag !== null) {
      const openEnd = html.indexOf(">", lt + 1 + rawTag.length);
      if (openEnd === -1) {
        out += html.slice(i); // незакрытый открывающий тег без '>' — оставляем как текст (как прежний regex не матчил)
        break;
      }
      out += `${html.slice(i, lt)} `;
      const close = findRawClose(html, rawTag, openEnd + 1);
      if (close === null) break; // нет закрытия — raw ест до EOF (не копируем остаток)
      i = close.end;
      continue;
    }
    // Открытие RCDATA (title/textarea) — содержимое ТЕКСТ (вложенные <script>/</main> не интерпретируем) ?
    const rcTag = matchOpenFrom(html, lt, RCDATA_TAGS);
    if (rcTag !== null) {
      const openEnd = html.indexOf(">", lt + 1 + rcTag.length);
      const close = openEnd === -1 ? null : findRawClose(html, rcTag, openEnd + 1);
      if (close === null) {
        out += html.slice(i); // незакрытый — весь хвост как текст (содержимое RCDATA не теряем)
        break;
      }
      // Открытие/закрытие как есть (их видит extractTitle/stripHtml), НУТРО — с экранированными '<'/'>' (иначе
      // литеральный </main>|</article>|<title> внутри textarea перечитался бы blockInners/extractTitle как разметка
      // и преждевременно закрыл доминирующий блок → потеря хвоста; ревью-находка, доводит фикс RCDATA до конца).
      out += `${html.slice(i, openEnd + 1)}${escapeAngles(html.slice(openEnd + 1, close.start))}${html.slice(close.start, close.end)}`;
      i = close.end;
      continue;
    }
    // Обычный `<` — не спец: копируем и идём дальше.
    out += html.slice(i, lt + 1);
    i = lt + 1;
  }
  return out;
}

/** Извлечь текст `<title>` ЛИНЕЙНО (anchored-regex + поиск закрытия от позиции; без ленивого скана). */
function extractTitle(html: string): string {
  const om = /<title(?=[\s/>])[^<>]*>/i.exec(html); // (?=[\s/>]): <title-bar>≠<title>; [^<>]* линеен на флуде
  if (om === null) return "";
  const start = om.index + om[0].length;
  const closeRe = /<\/title\s*>/gi;
  closeRe.lastIndex = start;
  const cm = closeRe.exec(html);
  return cm === null ? "" : html.slice(start, cm.index).trim();
}

/**
 * Снять теги (заменить `<…>` пробелом) и схлопнуть пробелы. Скан ЛИНЕЙНЫЙ (indexOf), а НЕ `/<[^>]+>/g`: тот
 * на входе с плотными `<` и редкими `>` (спам `<3`, «сырой» `<` в тексте/коде, битая разметка) давал O(n²)
 * (`[^>]+` жадно тянет до конца и бэктрекает на каждой позиции) → синхронный парс вешал event-loop (ревью-
 * находка ReDoS). Стрей-`<` без последующего `>` сохраняется как текст (как и прежний regex — `<[^>]+>` без
 * `>` не матчил, оставляя `<` на месте).
 */
export function stripHtml(html: string): string {
  return decodeEntities(stripTags(html).replace(/\s+/g, " ")).trim();
}

function stripTags(html: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      out += html.slice(i); // `<` без закрывающего `>` — литеральный текст (как /<[^>]+>/ его не матчил)
      break;
    }
    out += `${html.slice(i, lt)} `; // текст до тега + пробел вместо тега
    i = gt + 1;
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  mdash: "—", ndash: "–", laquo: "«", raquo: "»", hellip: "…",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", middot: "·", deg: "°",
  euro: "€", times: "×", shy: "",
};

/**
 * Декодировать HTML-сущности: ЧИСЛОВЫЕ (`&#171;` десятичн. / `&#xAB;` hex — покрывают ЛЮБОЙ символ, вкл.
 * numeric-кодированную кириллицу `&#1055;`) + распространённые именованные (в т.ч. RU-типографику «»—…„").
 * Раньше знали лишь 6 сущностей → `&mdash;`/`&laquo;`/`&#8212;`/numeric-кириллица текли в LLM литеральной
 * строкой (ревью-находка; для RU-ассистента частое). Один левонаправленный проход `replace` (без двойного
 * декодирования, в отличие от прежних последовательных replace: `&amp;lt;`→`&lt;`, а не `<`). Regex ЛИНЕЕН
 * (простые классы, без вложенных квантификаторов). Неизвестная/битая сущность остаётся как есть.
 */
function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88; // x/X
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : m;
  });
}

export class WebProvider implements IWebProvider {
  /** Поиск доступен ВСЕГДА: с ключом — Brave, без ключа — keyless DuckDuckGo (нужна лишь сеть). */
  readonly live = true;
  constructor(private readonly braveApiKey: string | undefined) {
    log.info("web.search", { provider: braveApiKey ? "brave (+ddg-фолбэк)" : "duckduckgo (keyless)" });
  }

  /** §12: с ключом — Brave (приоритет, лучше качество); пусто/сбой/без ключа — keyless DuckDuckGo. */
  async search(queryText: string, limit = 5): Promise<SearchHit[]> {
    if (this.braveApiKey) {
      const brave = await this.searchBrave(queryText, limit);
      if (brave.length > 0) return brave; // Brave дал результат — отдаём его
      // Brave пусто/протух/лимит → не молчим, идём в keyless-фолбэк
    }
    return this.searchDuckDuckGo(queryText, limit);
  }

  private async searchBrave(queryText: string, limit: number): Promise<SearchHit[]> {
    try {
      const url = `${BRAVE_URL}?q=${encodeURIComponent(queryText)}&count=${limit}`;
      const resp = await fetch(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": this.braveApiKey! },
        signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      });
      if (!resp.ok) {
        log.warn("Brave search не ок (→ DDG-фолбэк)", { status: resp.status });
        return [];
      }
      return parseBraveResults(await resp.json(), limit);
    } catch (e) {
      log.warn("Brave search ошибка (→ DDG-фолбэк)", e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  /** Keyless-поиск через DuckDuckGo Lite (HTML). Без ключа, нужна лишь сеть. */
  private async searchDuckDuckGo(queryText: string, limit: number): Promise<SearchHit[]> {
    try {
      const resp = await fetch(`${DDG_LITE_URL}?q=${encodeURIComponent(queryText)}`, {
        headers: { "User-Agent": SEARCH_UA, Accept: "text/html" },
        signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      });
      if (!resp.ok) {
        log.warn("DuckDuckGo не ок", { status: resp.status });
        return [];
      }
      return parseDuckDuckGoLite(await readCappedText(resp, MAX_HTML_BYTES), limit);
    } catch (e) {
      log.warn("DuckDuckGo ошибка", e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  async fetch(url: string): Promise<FetchedPage | null> {
    // SSRF-гард (§14): не читаем внутреннюю сеть/не-http(s) по запросу модели.
    if (!isFetchUrlAllowed(url)) {
      log.warn("web.fetch отклонён (SSRF-гард)", { url });
      return null;
    }
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "JarvisBot/0.1 (+readability)" },
        signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!resp.ok) return null;
      // Redirect-SSRF: конечный URL после редиректов мог увести во внутреннюю сеть —
      // ревалидируем (302 → 169.254.169.254/localhost не должен пройти).
      if (resp.url && resp.url !== url && !isFetchUrlAllowed(resp.url)) {
        log.warn("web.fetch: редирект в запрещённый адрес — отказ", { url, final: resp.url });
        return null;
      }
      // Потоковое чтение с жёстким лимитом байт (не доверяем content-length, не буферизуем всё).
      const html = await readCappedText(resp, MAX_HTML_BYTES);
      const page = extractReadable(html, url);
      // Ограничим объём текста (вход в LLM, §15).
      return { ...page, text: page.text.slice(0, 8000) };
    } catch (e) {
      log.warn("web.fetch ошибка", e instanceof Error ? e.message : String(e));
      return null;
    }
  }
}

/**
 * Кеширующий декоратор web (§12, §15): повторный одинаковый search/fetch не дёргает
 * Brave/сеть в пределах TTL. Пустые результаты не кешируются (стаб/сбой/нет ключа).
 */
export class CachingWebProvider implements IWebProvider {
  readonly live: boolean;
  private readonly searchCache: TtlCache<SearchHit[]>;
  private readonly fetchCache: TtlCache<FetchedPage>;

  constructor(
    private readonly inner: IWebProvider,
    opts: { searchTtlMs?: number; fetchTtlMs?: number; maxEntries?: number } = {},
  ) {
    this.live = inner.live;
    const maxEntries = opts.maxEntries ?? 500;
    this.searchCache = new TtlCache<SearchHit[]>({ ttlMs: opts.searchTtlMs ?? 10 * 60_000, maxEntries });
    this.fetchCache = new TtlCache<FetchedPage>({ ttlMs: opts.fetchTtlMs ?? 30 * 60_000, maxEntries });
  }

  async search(query: string, limit = 5): Promise<SearchHit[]> {
    const key = `${limit}:${query}`;
    const hit = this.searchCache.get(key);
    if (hit) return hit;
    const r = await this.inner.search(query, limit);
    if (r.length > 0) this.searchCache.set(key, r);
    return r;
  }

  async fetch(url: string): Promise<FetchedPage | null> {
    const hit = this.fetchCache.get(url);
    if (hit) return hit;
    const r = await this.inner.fetch(url);
    if (r !== null) this.fetchCache.set(url, r);
    return r;
  }

  get stats(): { search: CacheStats; fetch: CacheStats } {
    return { search: this.searchCache.stats, fetch: this.fetchCache.stats };
  }
}

/** Mock для тестов/дев: фиксированные результаты. */
export class MockWebProvider implements IWebProvider {
  readonly live = false;
  constructor(
    private readonly hits: SearchHit[] = [],
    private readonly page: FetchedPage | null = null,
  ) {}
  async search(): Promise<SearchHit[]> {
    return this.hits;
  }
  async fetch(): Promise<FetchedPage | null> {
    return this.page;
  }
}

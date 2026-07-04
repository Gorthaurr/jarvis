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
  const linkRe = /<a[^>]+href="([^"]*uddg=[^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
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
  const snipRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
  for (let m = snipRe.exec(html); m !== null; m = snipRe.exec(html)) snippets.push(stripHtml(m[1]!));
  const hits: SearchHit[] = [];
  for (let i = 0; i < links.length && hits.length < limit; i += 1) {
    hits.push({ title: links[i]!.title, url: links[i]!.url, snippet: snippets[i] ?? "" });
  }
  return hits;
}

/** Грубое извлечение читаемого текста из HTML (чистая функция). */
export function extractReadable(html: string, url = ""): FetchedPage {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim();
  // Убираем неинформативные блоки целиком.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = stripHtml(stripped);
  return { url, title: decodeEntities(title), text };
}

/** Снять теги и схлопнуть пробелы. */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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

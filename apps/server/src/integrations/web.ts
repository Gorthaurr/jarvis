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
  readonly live: boolean;
  constructor(private readonly braveApiKey: string | undefined) {
    this.live = Boolean(braveApiKey);
    if (!this.live) log.warn("BRAVE_SEARCH_API_KEY не задан — web.search в стаб-режиме ([])");
  }

  async search(queryText: string, limit = 5): Promise<SearchHit[]> {
    if (!this.live) return [];
    try {
      const url = `${BRAVE_URL}?q=${encodeURIComponent(queryText)}&count=${limit}`;
      const resp = await fetch(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": this.braveApiKey! },
      });
      if (!resp.ok) {
        log.warn("Brave search не ок", { status: resp.status });
        return [];
      }
      return parseBraveResults(await resp.json(), limit);
    } catch (e) {
      log.warn("web.search ошибка", e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  async fetch(url: string): Promise<FetchedPage | null> {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": "JarvisBot/0.1 (+readability)" } });
      if (!resp.ok) return null;
      const html = await resp.text();
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

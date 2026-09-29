/**
 * Веб лаборатории: детерминированный IWebProvider над `DesktopSeed.web` (адрес → HTML/текст). Сеть не трогаем никогда.
 * Нет страницы — `null` (как реальный fetch при сбое), а не выдуманный текст: оффлайн должен быть виден.
 */
import { type FetchedPage, type IWebProvider, type SearchHit, extractReadable } from "../../../apps/server/src/integrations/web.js";

const tokens = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);

export class LabWebProvider implements IWebProvider {
  readonly live = false;
  private pages = new Map<string, string>();

  constructor(pages: Record<string, string> = {}) {
    this.set(pages);
  }

  set(pages: Record<string, string>): void {
    this.pages = new Map(Object.entries(pages));
  }

  async fetch(url: string): Promise<FetchedPage | null> {
    const body = this.pages.get(url);
    return body === undefined ? null : extractReadable(body, url);
  }

  async search(query: string, limit = 5): Promise<SearchHit[]> {
    const q = tokens(query);
    if (q.length === 0) return [];
    const hits: Array<SearchHit & { score: number }> = [];
    for (const [url, body] of this.pages) {
      const page = extractReadable(body, url);
      const hay = new Set(tokens(`${url} ${page.title} ${page.text}`));
      const score = q.filter((t) => hay.has(t)).length;
      if (score > 0) hits.push({ title: page.title || url, url, snippet: page.text.slice(0, 160), score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score: _s, ...h }) => h);
  }
}

/**
 * Веб-знания (§12) — интерфейс + стаб.
 *
 * web.search — поиск (Brave/др.), web.fetch — загрузка и извлечение читаемого
 * текста страницы. Без BRAVE_SEARCH_API_KEY/сети — стаб с пустым результатом.
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("web");

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchedPage {
  url: string;
  title: string;
  /** Очищенный читаемый текст (без навигации/рекламы). */
  text: string;
}

export interface IWebProvider {
  search(query: string, limit?: number): Promise<SearchHit[]>;
  fetch(url: string): Promise<FetchedPage | null>;
  readonly live: boolean;
}

export class WebProvider implements IWebProvider {
  readonly live: boolean;
  constructor(private readonly braveApiKey: string | undefined) {
    this.live = Boolean(braveApiKey);
    if (!this.live) log.warn("BRAVE_SEARCH_API_KEY не задан — web в стаб-режиме");
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_query: string, _limit = 5): Promise<SearchHit[]> {
    if (!this.live) return [];
    // TODO(M? §12): реальный вызов Brave Search API.
    void this.braveApiKey;
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetch(_url: string): Promise<FetchedPage | null> {
    // TODO(M? §12): загрузка + readability-извлечение.
    return null;
  }
}

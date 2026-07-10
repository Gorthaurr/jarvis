/**
 * База ЭКСПЕРТНОГО ЗНАНИЯ по доменам (§экспертность) — «читать литературу перед экспертной задачей».
 *
 * Перед экспертной задачей (торговля и др.) Джарвис консультируется с дистиллятом предметной литературы,
 * чтобы рассуждать как эксперт, а не «от бедра». Документы — markdown в `docs/`, разбиты по разделам (## );
 * `consult` возвращает релевантные разделы по запросу. Расширяется ДОБАВЛЕНИЕМ домена в DOMAIN_FILES + .md
 * (универсально: завтра медицина/право/код — той же механикой). Живые источники модель добирает web_*.
 *
 * Чистый поиск по ключевым словам (детерминирован, тестируется без сети/эмбеддера). Семантика — апгрейд.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("knowledge");

/** Раздел знания: заголовок + тело. */
export interface KnowledgeSection {
  heading: string;
  body: string;
}

/**
 * Реестр доменов → файл(ы) свода (один .md ИЛИ список — тогда разделы сливаются под один домен).
 * Добавить домен = строка тут + .md в docs/. Добавить главу в домен = имя файла в массив.
 */
const DOMAIN_FILES: Record<string, string | string[]> = {
  trading: [
    "trading.md", // обзор/индекс
    "risk-management.md",
    "price-action.md",
    "market-structure.md",
    "indicators.md",
    "market-regimes.md",
    "trading-psychology.md",
    "quantitative-methods.md",
    "derivatives.md",
    "macro-intermarket.md",
    "trading-systems.md",
    // глубокие разборы методов/книг реального трейдинга
    "the-trading-process.md", // полный процесс сделки A→Z (главный)
    "support-resistance-levels.md",
    "wyckoff-method.md",
    "elder-triple-screen.md",
    "brooks-price-action.md",
    "smart-money-liquidity.md",
    "supply-demand-zones.md",
    "chart-patterns-classic.md",
    "dow-theory-trend.md",
    "market-profile-volume.md",
    "market-wizards-lessons.md",
    "entry-exit-execution.md",
    "crypto-trading-specifics.md",
  ],
};

/** Нормализация для матчинга: нижний регистр, ё→е, не-буквы→пробел. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-z0-9а-я]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Значимые слова запроса (≥3 символов). */
function tokenize(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((w) => w.length >= 3);
}

/** Документ: вступление (до первого ## ) + разделы. */
function parseDoc(md: string): { intro: string; sections: KnowledgeSection[] } {
  const parts = md.split(/^## /m);
  const intro = (parts[0] ?? "").trim();
  const sections = parts.slice(1).map((block) => {
    const nl = block.indexOf("\n");
    return {
      heading: (nl === -1 ? block : block.slice(0, nl)).trim(),
      body: (nl === -1 ? "" : block.slice(nl + 1)).trim(),
    };
  });
  return { intro, sections };
}

/** Релевантность раздела запросу: попадание в заголовок весомее тела. */
function scoreSection(s: KnowledgeSection, terms: readonly string[]): number {
  const h = normalize(s.heading);
  const b = normalize(s.body);
  let sc = 0;
  for (const t of terms) {
    if (h.includes(t)) sc += 3;
    sc += Math.min(b.split(t).length - 1, 5);
  }
  return sc;
}

const MAX_TEXT = 3200;

/** Результат консультации с базой знаний. */
export interface ConsultResult {
  found: boolean;
  /** Релевантные разделы (или вступление при пустом/непопавшем запросе). */
  text: string;
  /** Оглавление домена — чтобы модель уточнила запрос при промахе. */
  topics: string[];
}

export class KnowledgeBase {
  private readonly docs = new Map<string, { intro: string; sections: KnowledgeSection[] }>();

  constructor(docsDir?: string) {
    const dir = docsDir ?? join(dirname(fileURLToPath(import.meta.url)), "docs");
    for (const [domain, spec] of Object.entries(DOMAIN_FILES)) {
      const files = Array.isArray(spec) ? spec : [spec];
      const merged: { intro: string; sections: KnowledgeSection[] } = { intro: "", sections: [] };
      for (const file of files) {
        const path = join(dir, file);
        if (!existsSync(path)) continue;
        try {
          const doc = parseDoc(readFileSync(path, "utf8"));
          if (!merged.intro) merged.intro = doc.intro; // вступление берём из первого (индексного) файла
          merged.sections.push(...doc.sections);
        } catch (e) {
          log.warn("не удалось загрузить свод знаний", { domain, file, err: e instanceof Error ? e.message : String(e) });
        }
      }
      if (merged.sections.length > 0 || merged.intro) this.docs.set(domain, merged);
    }
    log.info("база знаний загружена", {
      domains: [...this.docs.keys()],
      sections: [...this.docs.values()].reduce((n, d) => n + d.sections.length, 0),
    });
  }

  domains(): string[] {
    return [...this.docs.keys()];
  }

  topics(domain: string): string[] {
    return this.docs.get(domain)?.sections.map((s) => s.heading) ?? [];
  }

  /** Достать релевантные разделы домена под запрос (top-`limit`). Пустой/непопавший запрос → вступление. */
  consult(domain: string, query: string, limit = 2): ConsultResult {
    const doc = this.docs.get(domain);
    if (!doc) return { found: false, text: "", topics: [] };
    const topics = doc.sections.map((s) => s.heading);
    const terms = tokenize(query);
    if (terms.length === 0) return { found: true, text: doc.intro.slice(0, MAX_TEXT), topics };
    const picked = doc.sections
      .map((s) => ({ s, score: scoreSection(s, terms) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
      .map((x) => x.s);
    if (picked.length === 0) return { found: true, text: doc.intro.slice(0, MAX_TEXT), topics };
    const text = picked.map((s) => `## ${s.heading}\n${s.body}`).join("\n\n");
    return { found: true, text: text.slice(0, MAX_TEXT), topics };
  }
}

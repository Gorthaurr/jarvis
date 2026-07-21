/**
 * Эпизодическая (долговременная) память (§8).
 *
 * pgvector-хранилище фактов/предпочтений/событий с семантическим поиском (§1, §8).
 * Эмбеддинги — IEmbeddingProvider. Две реализации:
 *  - PgVectorEpisodicMemory — прод (Postgres+pgvector), схема §13;
 *  - InMemoryEpisodicMemory — dev/тесты без БД (косинус в памяти процесса).
 * Фабрика выбирает по наличию DATABASE_URL.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { query } from "../db/pool.js";
import type { IEmbeddingProvider } from "../integrations/openai-embeddings.js";

const log: Logger = createLogger("episodic");

/** Тип эпизода (§13: kind). */
export type EpisodeKind = "preference" | "fact" | "event";

export interface Episode {
  id: string;
  userId: string;
  kind: EpisodeKind;
  text: string;
  /** unix ms. */
  ts: number;
  salience?: number;
}

/** Результат поиска: эпизод + косинусная близость [0,1]. */
export interface EpisodeHit {
  episode: Episode;
  score: number;
}

export interface EpisodicMemory {
  /** minScore — отсечь хиты с косинусом ниже порога (анти-конфабуляция). 0 → без отсечения. */
  search(userId: string, queryText: string, k: number, minScore?: number): Promise<EpisodeHit[]>;
  write(episode: Omit<Episode, "id">): Promise<void>;
  /**
   * Б2 (микро-опт латентности): есть ли у пользователя ХОТЬ ОДНА живая запись. Пустой стор (новый
   * пользователь) → retrieval-поиск на КАЖДОМ голосовом ходе — мёртвая 350мс-гонка (embed+ANN ради
   * гарантированного []). Дешёвая проверка (LIMIT 1, без эмбеддинга) с process-кэшем позволяет её
   * пропустить. Опционально — вызывающий деградирует к обычному search, если метода нет.
   */
  hasEntries?(userId: string): Promise<boolean>;
  /**
   * Досчитать эмбеддинги для строк с embedding IS NULL (факты, сохранённые пока эмбеддер был мёртв —
   * иначе они НИКОГДА не вернутся в поиск). Идемпотентно, безопасно звать на каждом boot. Эмбеддер
   * по-прежнему мёртв → 0 исправлено (попробуем в следующий раз). Возвращает счётчики.
   */
  backfillMissingEmbeddings?(limit?: number): Promise<{ scanned: number; fixed: number }>;
  /**
   * ЧЕСТНОЕ ЗАБЫВАНИЕ (аудит контекста 2026-07-20): пометить stale эпизоды, семантически близкие к
   * `queryText` (косинус ≥ minScore, до `max` штук). Раньше забывания НЕ БЫЛО ни на одном горизонте:
   * stale в рантайме никто не выставлял → устаревший/противоречащий факт жил вечно в доверенном блоке
   * промпта. stale=true — МЯГКОЕ удаление (обратимо, не hard-delete): факт перестаёт всплывать в
   * search, но строка цела. Порог держать ВЫСОКИМ (не стереть лишнее). Возвращает счётчик + тексты.
   */
  markStale?(userId: string, queryText: string, minScore: number, max?: number): Promise<{ staled: number; texts: string[] }>;
}

/**
 * Порог релевантности АВТО-retrieval'а (env JARVIS_MEMORY_MIN_SCORE). Корень бага «вспоминает то,
 * чего не было»: top-k соседи вшивались в доверенный блок промпта как «факты» БЕЗ порога → тематически
 * несвязанный сосед (косинус ~0.7) читался моделью как истина.
 *
 * Аудит контекста 2026-07-20: порог ВКЛЮЧЁН по умолчанию (0.82), ОТКАЛИБРОВАН НА ЖИВОМ e5-small
 * (не угадан). Замер: запрос «где я работаю» против стора → релевантный «работает в Сбербанке»=0.859,
 * НЕсвязанные «ходил в кино»=0.793 / «любит велосипед»=0.787; несвязанный запрос «погода на Марсе» →
 * весь стор 0.754-0.762. e5-small СИЛЬНО сжимает косинусы вверх (даже несвязанное ~0.75-0.79), поэтому
 * наивные 0.7-0.78 протекают шумом. 0.82 — разделяющая граница (держит 0.859, режет ≤0.793); совпадает
 * со skill-semantic-min проекта. Почему безопасно (страх над-фильтрации снят):
 *   • курируемые факты профиля (высокоценные) идут ОТДЕЛЬНЫМ asserted-блоком и порогом НЕ трогаются —
 *     фильтруется лишь эпизодический recall, «потерять важный факт» нельзя;
 *   • прошедший порог recall ХЕДЖИРУЕТСЯ («возможно, из прошлых разговоров — сверься», persona/index.ts)
 *     → над-фильтрация в серой зоне почти бесплатна, честность несёт хедж, не порог.
 * Явный `search(..., 0)` (дедуп на записи, explicit memory_search) порог НЕ применяет. Тюн/выкл — env.
 *
 * EMBEDDER-AWARE (адверс-ревью F4): 0.82 откалиброван ПОД e5-small. При OPENAI_API_KEY поднимается
 * OpenAiEmbeddingProvider (gateway/server.ts), у которого косинусы релевантного НИЖЕ (~0.4-0.6, не 0.85+),
 * → 0.82 отсёк бы ВЕСЬ авто-ретривал молча. Тот же сигнал, что выбирает эмбеддер, выбирает и дефолт:
 * OpenAI → 0 (не над-фильтруем; честность несёт ХЕДЖ-блок, он универсален и от порога не зависит; владелец
 * калибрует под OpenAI явным env). Явный JARVIS_MEMORY_MIN_SCORE перекрывает оба пути.
 */
export function memoryMinScore(): number {
  const raw = process.env.JARVIS_MEMORY_MIN_SCORE;
  const n = Number.parseFloat(raw ?? "");
  if (raw != null && Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  // OpenAI-эмбеддер (opt-in) — иная шкала косинусов; дефолт-порог e5 к нему не применяем.
  if (process.env.OPENAI_API_KEY) return 0;
  return 0.82;
}

/** Косинусная близость двух векторов. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** pgvector-литерал: [0.1,0.2,...]. */
function toVectorLiteral(vec: readonly number[]): string {
  return `[${vec.join(",")}]`;
}

/** Прод: Postgres + pgvector (схема §13). Без БД деградирует в []/no-op. */
export class PgVectorEpisodicMemory implements EpisodicMemory {
  /** Б2: userId, у которых ТОЧНО есть записи (монотонно: раз true — навсегда true в процессе). */
  private readonly known = new Set<string>();

  constructor(private readonly embedder: IEmbeddingProvider) {}

  async hasEntries(userId: string): Promise<boolean> {
    if (this.known.has(userId)) return true; // уже знаем — без запроса
    const res = await query(
      `select 1 from episodic_memory where user_id = $1 and stale = false limit 1`,
      [userId],
    );
    // Нет БД (res===null) → консервативно true: не глушим retrieval из-за отсутствия сигнала.
    const has = res === null ? true : res.rows.length > 0;
    if (has) this.known.add(userId);
    return has;
  }

  async search(userId: string, queryText: string, k: number, minScore = 0): Promise<EpisodeHit[]> {
    const vec = await this.embedder.embed(queryText, "query");
    if (!vec) return [];
    const res = await query(
      `select id, user_id, kind, text,
              extract(epoch from created_at) * 1000 as ts,
              salience,
              1 - (embedding <=> $2::vector) as score
         from episodic_memory
        where user_id = $1 and stale = false and embedding is not null
        order by embedding <=> $2::vector
        limit $3`,
      [userId, toVectorLiteral(vec), k],
    );
    if (!res) return [];
    return res.rows
      .map((r) => ({
        episode: {
          id: String(r.id),
          userId: String(r.user_id),
          kind: String(r.kind) as EpisodeKind,
          text: String(r.text),
          ts: Number(r.ts),
          salience: r.salience == null ? undefined : Number(r.salience),
        },
        score: Number(r.score),
      }))
      .filter((h) => h.score >= minScore);
  }

  async write(episode: Omit<Episode, "id">): Promise<void> {
    this.known.add(episode.userId); // Б2: после записи стор точно не пуст — hasEntries вернёт true без запроса
    const vec = await this.embedder.embed(episode.text, "passage");
    // ГРОМКО, не тихо: без вектора (нет ключа эмбеддера / транзиентный сбой) строка пишется с
    // embedding=NULL, а search фильтрует `embedding is not null` → факт НИКОГДА не вернётся в
    // поиск («говорил же» → не помнит). Раньше это было молча. Теперь warn + флаг на бэкилл.
    if (!vec) {
      log.warn("episodic.write без эмбеддинга — факт не попадёт в поиск до бэкилла", {
        kind: episode.kind,
        textPreview: episode.text.slice(0, 60),
      });
    }
    const res = await query(
      `insert into episodic_memory (user_id, kind, text, salience, embedding)
       values ($1, $2, $3, $4, $5::vector)`,
      [
        episode.userId,
        episode.kind,
        episode.text,
        episode.salience ?? 0.5,
        vec ? toVectorLiteral(vec) : null,
      ],
    );
    if (!res) log.debug("episodic.write no-op (нет БД)");
  }

  async backfillMissingEmbeddings(limit = 1000): Promise<{ scanned: number; fixed: number }> {
    const res = await query(
      `select id, text from episodic_memory
        where embedding is null and stale = false
        order by created_at desc
        limit $1`,
      [limit],
    );
    if (!res || res.rows.length === 0) return { scanned: 0, fixed: 0 };
    let fixed = 0;
    for (const r of res.rows) {
      const vec = await this.embedder.embed(String(r.text), "passage");
      if (!vec) break; // эмбеддер мёртв → нет смысла продолжать, добьём на следующем boot
      const upd = await query(`update episodic_memory set embedding = $2::vector where id = $1`, [
        String(r.id),
        toVectorLiteral(vec),
      ]);
      if (upd) fixed += 1;
    }
    if (fixed > 0) log.info("эпизодическая память: бэкилл эмбеддингов (осиротевшие факты → в поиск)", { scanned: res.rows.length, fixed });
    return { scanned: res.rows.length, fixed };
  }

  async markStale(userId: string, queryText: string, minScore: number, max = 5): Promise<{ staled: number; texts: string[] }> {
    const vec = await this.embedder.embed(queryText, "query");
    if (!vec) return { staled: 0, texts: [] };
    const res = await query(
      `select id, text, 1 - (embedding <=> $2::vector) as score
         from episodic_memory
        where user_id = $1 and stale = false and embedding is not null
        order by embedding <=> $2::vector
        limit $3`,
      [userId, toVectorLiteral(vec), max],
    );
    if (!res) return { staled: 0, texts: [] };
    const matches = res.rows.filter((r) => Number(r.score) >= minScore);
    if (matches.length === 0) return { staled: 0, texts: [] };
    const ids = matches.map((r) => String(r.id));
    // stale=true — МЯГКОЕ удаление (строки целы, честно обратимо): search фильтрует `stale = false`.
    const upd = await query(`update episodic_memory set stale = true where id = any($1::uuid[])`, [ids]);
    const texts = matches.map((r) => String(r.text));
    if (upd) log.info("эпизодическая память: факты помечены stale (забыто по запросу)", { count: matches.length });
    return { staled: upd ? matches.length : 0, texts: upd ? texts : [] };
  }
}

/** Dev/тесты: косинусный поиск в памяти процесса. */
export class InMemoryEpisodicMemory implements EpisodicMemory {
  private readonly store: Array<{ episode: Episode; vec: number[] }> = [];
  private seq = 0;

  constructor(private readonly embedder: IEmbeddingProvider) {}

  async search(userId: string, queryText: string, k: number, minScore = 0): Promise<EpisodeHit[]> {
    const vec = await this.embedder.embed(queryText, "query");
    if (!vec) return [];
    return this.store
      .filter((e) => e.episode.userId === userId)
      .map((e) => ({ episode: e.episode, score: cosine(vec, e.vec) }))
      .filter((h) => h.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async write(episode: Omit<Episode, "id">): Promise<void> {
    const vec = await this.embedder.embed(episode.text, "passage");
    this.seq += 1;
    this.store.push({
      episode: { ...episode, id: `mem-${this.seq}` },
      vec: vec ?? [],
    });
  }

  async hasEntries(userId: string): Promise<boolean> {
    return this.store.some((e) => e.episode.userId === userId);
  }

  async markStale(userId: string, queryText: string, minScore: number, max = 5): Promise<{ staled: number; texts: string[] }> {
    const vec = await this.embedder.embed(queryText, "query");
    if (!vec) return { staled: 0, texts: [] };
    const ranked = this.store
      .map((e, idx) => ({ idx, text: e.episode.text, score: e.episode.userId === userId ? cosine(vec, e.vec) : -1 }))
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, max);
    if (ranked.length === 0) return { staled: 0, texts: [] };
    // In-memory без колонки stale — удаляем из стора (для search-путей эквивалентно stale=true).
    const drop = new Set(ranked.map((x) => x.idx));
    const kept = this.store.filter((_, i) => !drop.has(i));
    this.store.length = 0;
    this.store.push(...kept);
    return { staled: ranked.length, texts: ranked.map((x) => x.text) };
  }

  /** Размер хранилища (диагностика тестов). */
  get size(): number {
    return this.store.length;
  }
}

/** Фабрика: при наличии БД — pgvector, иначе in-memory. */
export function createEpisodicMemory(
  embedder: IEmbeddingProvider,
  hasDatabase: boolean,
): EpisodicMemory {
  if (hasDatabase) {
    log.info("эпизодическая память: pgvector");
    return new PgVectorEpisodicMemory(embedder);
  }
  log.info("эпизодическая память: in-memory (нет DATABASE_URL)");
  return new InMemoryEpisodicMemory(embedder);
}

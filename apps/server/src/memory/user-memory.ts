/**
 * Единый ПИСАТЕЛЬ памяти о пользователе (ревью памяти 2026-07-10, А2/А9): семантический дедуп +
 * запись в episodic + мост в курируемый профиль. Используется инструментом `memory_write` (модель
 * пишет осознанно) и рефлекс-бэкстопом (`agent/memory-reflect.ts`). Один код — одна дисциплина.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { type EpisodeKind, type EpisodicMemory } from "./episodic.js";
import { addFact, removeFactsMatching } from "../brain/profile.js";

const log: Logger = createLogger("memory:write");

/** Порог семантического дубля на записи (e5-косинус; паттерн skills.findDuplicateSemantic). */
const DEDUP_MIN = 0.93;

/**
 * Порог семантического совпадения для ЗАБЫВАНИЯ (env JARVIS_MEMORY_FORGET_MIN). ВЫШЕ retrieval-порога:
 * стереть (пусть и обратимо) чужой факт хуже, чем не показать recall — поэтому консервативно.
 * ФУНКЦИЯ, не module-const (адверс-ревью F5): `.env` грузится ПОСЛЕ ESM-хойста импортов (грабля проекта,
 * см. local-embeddings), поэтому const на module-load игнорировал бы JARVIS_MEMORY_FORGET_MIN из .env.
 *
 * EMBEDDER-AWARE (адверс-ревью 2-й раунд F6, зеркально memoryMinScore/F4): e5-small → 0.85 (родня
 * skill-semantic 0.82 / dedup 0.93 = «точно про то же»). На OpenAI-эмбеддере (opt-in) шкала косинусов
 * ИНАЯ — жёсткие 0.85 не сматчили бы НИ ОДИН эпизод → markStale=0, семантическое забывание молча мертво
 * (а retrieval-порог F4 там 0 → устаревший эпизод всплывал бы вечно). На OpenAI дефолт 0.6: выше
 * тематического шума (~0.4-0.6), ловит перефраз-уровень цели забывания; НЕкалиброван вживую (нет OpenAI-
 * данных) → консервативен, владелец тюнит JARVIS_MEMORY_FORGET_MIN. Профиль-чистка лексическая (embedder-
 * независима) работает на обоих путях.
 */
export function forgetMinScore(): number {
  const raw = process.env.JARVIS_MEMORY_FORGET_MIN;
  const n = Number.parseFloat(raw ?? "");
  if (raw != null && Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  return process.env.OPENAI_API_KEY ? 0.6 : 0.85;
}

const foldMem = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е");

export type WriteMemoryOutcome = "written" | "duplicate" | "empty";

/**
 * Записать устойчивый факт/предпочтение/событие: дедуп → episodic.write → (fact|preference → профиль).
 * Сбой дедуп-поиска НЕ блокирует запись (лучше дубль, чем потерянный факт).
 */
export async function writeUserMemory(
  episodic: EpisodicMemory,
  userId: string,
  kind: EpisodeKind,
  text: string,
): Promise<WriteMemoryOutcome> {
  const t = text.trim();
  if (!t) return "empty";
  try {
    const [top] = await episodic.search(userId, t, 1, 0);
    if (top && top.score >= DEDUP_MIN) {
      log.info("память: дубль факта не записан (семантический дедуп)", {
        score: Number(top.score.toFixed(3)),
        existing: top.episode.text.slice(0, 60),
      });
      return "duplicate";
    }
  } catch {
    /* поиск упал — пишем как есть */
  }
  await episodic.write({ userId, kind, text: t, ts: Date.now() });
  // Мост в курируемый профиль: его читают промпт и контекстное приветствие; переживает pgvector-down.
  if (kind === "fact" || kind === "preference") void addFact(userId, t);
  log.info("память: факт записан", { kind, preview: t.slice(0, 60) });
  return "written";
}

export interface ForgetOutcome {
  /** Сколько записей реально забыто (stale-эпизоды + удалённые курируемые факты, без двойного счёта). */
  forgotten: number;
  /** Тексты забытого — для честного отчёта пользователю («Забыл: …»). */
  texts: string[];
}

/**
 * ЧЕСТНО ЗАБЫТЬ устаревший/ошибочный факт (аудит контекста 2026-07-20): помечает stale близкие эпизоды
 * (обратимо, порог FORGET_MIN) + убирает совпадающие курируемые факты из профиля. Единый читатель-
 * забыватель, зеркало writeUserMemory. Модель зовёт при ПОПРАВКЕ факта (сменил работу/город/вкус) —
 * иначе доверенный блок промпта неограниченно копит устаревшее (раньше забывания не было ВООБЩЕ).
 * markStale опционален у провайдера (старый мок без него) → деградируем к чистке профиля.
 */
export async function forgetUserMemory(
  episodic: EpisodicMemory,
  userId: string,
  query: string,
): Promise<ForgetOutcome> {
  const q = query.trim();
  if (!q) return { forgotten: 0, texts: [] };
  let staled: { staled: number; texts: string[] } = { staled: 0, texts: [] };
  try {
    staled = (await episodic.markStale?.(userId, q, forgetMinScore(), 5)) ?? { staled: 0, texts: [] };
  } catch {
    /* markStale упал/нет БД — профиль всё равно чистим (мост живёт без pgvector) */
  }
  // Чистим профиль по запросу И по фактически сматченным эпизодам (их формулировка точнее запроса).
  const removedFacts = await removeFactsMatching(userId, [q, ...staled.texts]);
  // Дедуп двойного счёта по FOLD (F1b): байт-идентичный мост эпизод↔профиль (доминирующий путь) —
  // один логический факт, удалённый обоими путями, считаем ОДИН раз. Exact-match тут промахивался бы
  // на регистре/ё. `forgotten` — число РАЗЛИЧНЫХ забытых записей (не «затронутых строк»).
  const staledFolds = new Set(staled.texts.map(foldMem));
  const extraFacts = removedFacts.filter((f) => !staledFolds.has(foldMem(f)));
  const forgotten = staled.staled + extraFacts.length;
  // texts для отчёта — тоже fold-дедуп (не показываем один факт двумя формулировками).
  const seen = new Set<string>();
  const texts = [...staled.texts, ...removedFacts].filter((t) => {
    const k = foldMem(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (forgotten > 0) {
    log.info("память: забыто по запросу", { query: q.slice(0, 60), episodes: staled.staled, facts: removedFacts.length });
  }
  return { forgotten, texts };
}

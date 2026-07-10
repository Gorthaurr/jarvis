/**
 * Единый ПИСАТЕЛЬ памяти о пользователе (ревью памяти 2026-07-10, А2/А9): семантический дедуп +
 * запись в episodic + мост в курируемый профиль. Используется инструментом `memory_write` (модель
 * пишет осознанно) и рефлекс-бэкстопом (`agent/memory-reflect.ts`). Один код — одна дисциплина.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { type EpisodeKind, type EpisodicMemory } from "./episodic.js";
import { addFact } from "../brain/profile.js";

const log: Logger = createLogger("memory:write");

/** Порог семантического дубля на записи (e5-косинус; паттерн skills.findDuplicateSemantic). */
const DEDUP_MIN = 0.93;

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

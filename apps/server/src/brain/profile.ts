/**
 * Персистентный профиль пользователя (§8, §11) — чтобы Джарвис ПОМНИЛ, а не спрашивал
 * имя каждый раз. Имя/факты хранятся на диске (data/profile.json) и переживают рестарт.
 * Имя подставляется в системный промпт (persona), приветствие здоровается по имени.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("profile");
const DATA_DIR = join(process.cwd(), "data");
const PROFILE_PATH = join(DATA_DIR, "profile.json");

export interface UserProfile {
  /** Как обращаться к пользователю (его имя/предпочитаемая форма). */
  displayName?: string;
  /** Произвольные факты о пользователе (для «лучшего анализа»). */
  facts?: string[];
  /** Текущий режим-«маска» Джарвиса (§11): id из persona/modes. По умолч. — дворецкий. */
  mode?: string;
}

let cache: UserProfile = {};

/** Загрузить профиль с диска (один раз на старте). Безопасно при отсутствии файла. */
export async function loadProfile(): Promise<UserProfile> {
  try {
    cache = JSON.parse(await readFile(PROFILE_PATH, "utf8")) as UserProfile;
    log.info("профиль загружен", { displayName: cache.displayName, facts: cache.facts?.length ?? 0 });
  } catch {
    cache = {};
    log.info("профиль пуст (новый пользователь)");
  }
  return cache;
}

/** Текущий профиль (синхронно, из кеша). */
export function getProfile(): UserProfile {
  return cache;
}

/** Сохранить имя пользователя (персист). */
export async function setDisplayName(name: string): Promise<void> {
  cache.displayName = name;
  await persist();
  log.info("профиль: имя сохранено", { displayName: name });
}

/** Сохранить текущий режим-маску (§11, персист). */
export async function setMode(mode: string): Promise<void> {
  cache.mode = mode;
  await persist();
  log.info("профиль: режим сохранён", { mode });
}

/** Добавить факт о пользователе (без дублей). */
export async function addFact(fact: string): Promise<void> {
  const f = fact.trim();
  if (!f) return;
  cache.facts = cache.facts ?? [];
  if (cache.facts.includes(f)) return;
  cache.facts.push(f);
  await persist();
}

async function persist(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(PROFILE_PATH, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    log.warn("профиль: не удалось сохранить", e instanceof Error ? e.message : String(e));
  }
}

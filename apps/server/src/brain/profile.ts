/**
 * Персистентный профиль пользователя (§8, §11; Фаза 6B/B3 — ПАРТИЦИЯ по userId) — чтобы Джарвис
 * ПОМНИЛ, а не спрашивал имя каждый раз. Имя/факты/режим/эмоция/язык/контекст хранятся на диске и
 * переживают рестарт.
 *
 * §6B/B3: РАНЬШЕ был ОДИН module-global `cache` БЕЗ userId — второй пользователь перетирал имя/факты/
 * язык первого (мультитенант-утечка #1 из аудита). Теперь профиль партиционирован по userId (зеркало
 * working-store): Map<userId, UserProfile> + файл на пользователя.
 *   • КОНТИНЬЮИТИ: DEV_USER остаётся в legacy `data/profile.json` → существующая установка НИЧЕГО не
 *     теряет при апгрейде (нулевая миграция). Прочие — в `data/profile/<userId>.json`.
 *   • loadProfile(userId) грузит раздел в кеш на старте сессии (зовётся в handshake ДО makeSessionContext);
 *     getProfile(userId) — синхронно из кеша; setX(userId,…) мутируют раздел + персист на пользователя.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataDir } from "../paths.js";

const log: Logger = createLogger("profile");
const DATA_DIR = dataDir(); // §универсальность: JARVIS_DATA_DIR (инсталлер) → иначе cwd/data
// Мирроринг seed-пользователя (infra/migrations/0002_seed_dev.sql / gateway/identity.ts DEV_USER):
// его раздел остаётся в legacy-файле data/profile.json → апгрейд установки НЕ теряет имя/факты.
const DEV_USER = "00000000-0000-0000-0000-000000000001";

export interface UserProfile {
  /** Как обращаться к пользователю (его имя/предпочитаемая форма). */
  displayName?: string;
  /** Произвольные факты о пользователе (для «лучшего анализа»). */
  facts?: string[];
  /** Текущий режим-«маска» Джарвиса (§11): id из persona/modes. По умолч. — дворецкий. */
  mode?: string;
  /** Текущая ЭМОЦИЯ подачи (§21): Emotion из integrations/tts-emotion. По умолч. — нейтрально. */
  emotion?: string;
  /** Язык общения (из настроек UI): "ru"/"en". По умолч. — русский. */
  language?: string;
  /** Свободный контекст о пользователе из настроек UI (стиль, привычки, как обращаться). */
  context?: string;
  /** Когда последний раз звучало приветствие-онбординг (unix ms) — кулдаун А6, ревью 2026-07-10. */
  lastGreetedAt?: number;
  /** Когда последний раз прогонялся «сон-цикл» консолидации памяти (unix ms) — триггер Б1, раз в день. */
  lastConsolidatedAt?: number;
}

const cache = new Map<string, UserProfile>();

function fileFor(userId: string): string {
  // Континьюити: раздел dev-пользователя — в существующем data/profile.json (не трогаем).
  if (userId === DEV_USER) return join(DATA_DIR, "profile.json");
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";
  return join(DATA_DIR, "profile", `${safe}.json`);
}

/** Загрузить профиль пользователя с диска в кеш (на старте сессии). Безопасно при отсутствии файла. */
export async function loadProfile(userId: string): Promise<UserProfile> {
  let p: UserProfile = {};
  try {
    p = JSON.parse(await readFile(fileFor(userId), "utf8")) as UserProfile;
    log.info("профиль загружен", { userId, displayName: p.displayName, facts: p.facts?.length ?? 0 });
  } catch {
    log.info("профиль пуст (новый пользователь)", { userId });
  }
  cache.set(userId, p);
  return p;
}

/** Текущий профиль пользователя (синхронно, из кеша; {} если не загружен). */
export function getProfile(userId: string): UserProfile {
  return cache.get(userId) ?? {};
}

/** Запись профиля в кеше (создаёт пустую, если раздел ещё не загружен). */
function entry(userId: string): UserProfile {
  let p = cache.get(userId);
  if (!p) {
    p = {};
    cache.set(userId, p);
  }
  return p;
}

/** Сохранить имя пользователя (персист). */
export async function setDisplayName(userId: string, name: string): Promise<void> {
  entry(userId).displayName = name;
  await persist(userId);
  log.info("профиль: имя сохранено", { userId, displayName: name });
}

/** Сохранить текущий режим-маску (§11, персист). */
export async function setMode(userId: string, mode: string): Promise<void> {
  entry(userId).mode = mode;
  await persist(userId);
  log.info("профиль: режим сохранён", { userId, mode });
}

/** Сохранить текущую эмоцию подачи (§21, персист). Кеш обновляется СРАЗУ — применяется уже к этому ходу. */
export async function setEmotion(userId: string, emotion: string): Promise<void> {
  entry(userId).emotion = emotion;
  await persist(userId);
  log.info("профиль: эмоция сохранена", { userId, emotion });
}

/** Сохранить язык общения (из настроек UI, персист). */
export async function setLanguage(userId: string, language: string): Promise<void> {
  const l = language.trim();
  const p = entry(userId);
  if (!l || l === p.language) return;
  p.language = l;
  await persist(userId);
  log.info("профиль: язык сохранён", { userId, language: l });
}

/** Сохранить свободный контекст о пользователе (из настроек UI, персист). Пустая строка очищает. */
export async function setContext(userId: string, context: string): Promise<void> {
  const c = context.trim();
  const p = entry(userId);
  if (c === (p.context ?? "")) return;
  p.context = c;
  await persist(userId);
  log.info("профиль: контекст сохранён", { userId, len: c.length });
}

/** Отметить произнесённое приветствие (кулдаун онбординга А6, ревью 2026-07-10). */
export async function setLastGreeted(userId: string): Promise<void> {
  entry(userId).lastGreetedAt = Date.now();
  await persist(userId);
}

/** Отметить прогон «сон-цикла» консолидации памяти (Б1, раз в день). */
export async function setLastConsolidated(userId: string): Promise<void> {
  entry(userId).lastConsolidatedAt = Date.now();
  await persist(userId);
}

/** Кап курируемых фактов профиля (ревью памяти 2026-07-10, А2): профиль — выжимка, не дамп. */
const MAX_PROFILE_FACTS = 20;

/** Добавить факт о пользователе (без дублей; при переполнении вытесняется старейший). */
export async function addFact(userId: string, fact: string): Promise<void> {
  const f = fact.trim();
  if (!f) return;
  const p = entry(userId);
  p.facts = p.facts ?? [];
  if (p.facts.includes(f)) return;
  p.facts.push(f);
  while (p.facts.length > MAX_PROFILE_FACTS) p.facts.shift(); // FIFO: старейшее уступает свежему
  await persist(userId);
  log.info("профиль: факт добавлен", { userId, count: p.facts.length, preview: f.slice(0, 60) });
}

const foldFact = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е");
/** Значимые токены (слова/числа ≥3 симв) нормализованной строки — для ПОСЛОВНОЙ сверки, не substring. */
const factTokens = (s: string): string[] => foldFact(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);

/** Кап удаляемых за один forget профиль-фактов (defense-in-depth против массового сноса). */
const MAX_FORGET_FACTS = 5;

/**
 * ЧЕСТНОЕ ЗАБЫВАНИЕ (аудит контекста 2026-07-20; УЖЕСТОЧЕНО адверс-ревью F1): убрать курируемые факты,
 * соответствующие `needles`. Раньше факты только копились (FIFO по возрасту) — устаревший «работаю в
 * Сбере» жил рядом с новым «в Яндексе».
 *
 * СВЕРКА ПОСЛОВНАЯ (не сырой substring — тот сносил несвязанное: «кот»⊂«скот», «люблю кофе»⊂компаундный
 * эпизод-нидл). Факт удаляется, только если:
 *   • folded факт РАВЕН folded needle (байт-идентичный мост эпизод↔профиль — доминирующий путь), ИЛИ
 *   • ВСЕ значимые токены needle (их ≥2) содержатся в токенах факта (needle ⊆ fact): «работает в
 *     Сбербанке» → «работает в Сбербанке аналитиком».
 * НАПРАВЛЕНИЕ fact ⊆ needle УБРАНО — именно оно давало collateral (атомарный факт, случайно упомянутый
 * в длинном эпизод-нидле). Одиночный/короткий needle (<2 токенов) снести профиль-факт НЕ может (кроме
 * точного равенства) — «забудь Москву» больше не стирает и «работаю в Москве», и «живу в Москве».
 * Кап MAX_FORGET_FACTS. Best-effort по словам; семантику несёт episodic.markStale в forgetUserMemory.
 */
export async function removeFactsMatching(userId: string, needles: readonly string[]): Promise<string[]> {
  const p = entry(userId);
  if (!p.facts || p.facts.length === 0) return [];
  const specs = needles
    .map((n) => ({ fold: foldFact(n), tokens: factTokens(n) }))
    .filter((s) => s.fold.length >= 3);
  if (specs.length === 0) return [];
  const removed: string[] = [];
  p.facts = p.facts.filter((f) => {
    if (removed.length >= MAX_FORGET_FACTS) return true; // кап достигнут — прочие факты не трогаем
    const ff = foldFact(f);
    const ftoks = factTokens(f);
    const hit = specs.some(
      (s) => ff === s.fold || (s.tokens.length >= 2 && s.tokens.every((t) => ftoks.includes(t))),
    );
    if (hit) removed.push(f);
    return !hit;
  });
  if (removed.length > 0) {
    await persist(userId);
    log.info("профиль: факт(ы) забыты", { userId, count: removed.length, remaining: p.facts.length });
  }
  return removed;
}

/** Сериализация записей НА ПОЛЬЗОВАТЕЛЯ: setX зовутся fire-and-forget (void) — без цепочки два
 *  writeFile в один файл могли интерливиться/побить JSON. Цепочка per-userId (разные юзеры параллельно). */
const writeChains = new Map<string, Promise<void>>();

function persist(userId: string): Promise<void> {
  const prev = writeChains.get(userId) ?? Promise.resolve();
  const next = prev.then(() => doPersist(userId));
  writeChains.set(userId, next);
  return next;
}

async function doPersist(userId: string): Promise<void> {
  const p = cache.get(userId) ?? {};
  const file = fileFor(userId);
  try {
    await mkdir(dirname(file), { recursive: true });
    // Атомарно: tmp → rename. Краш посреди записи оставит целым прежний файл, не огрызок.
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(p, null, 2), "utf8");
    await rename(tmp, file);
  } catch (e) {
    log.warn("профиль: не удалось сохранить", { userId, error: e instanceof Error ? e.message : String(e) });
  }
}

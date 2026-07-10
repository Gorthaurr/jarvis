/**
 * Опытная память РЕЗОЛВА получателей (§ концепт+100%+скорость, требование Антона 2026-06-20).
 *
 * «Помню, как зарезолвил в прошлый раз → в этот раз быстро и точно.» Первый раз Джарвис ищет
 * человека общим путём (поиск+транслит-варианты → кандидаты → pickRecipient/модель) — небыстро.
 * На ВЕРИФИЦИРОВАННОМ успехе запоминаем {query → peerId, title}: peerId стабилен (не зависит от
 * переименований, immune к рандом-пабликам). В следующий раз — recall → открыть СРАЗУ по peerId
 * (fast-path), verify подтверждает; не подтвердился (контакт пропал/переименован) → forget +
 * откат на общий путь (self-heal). Инвариант: память = ГИПОТЕЗА, доставка = страж → 100% и на
 * cache-hit (без сверки успех не рапортуем).
 *
 * Зеркалит persist-паттерн task-store.ts (атомарно tmp→rename, дебаунс, flush на close). Чистая
 * логика (remember/recall/forget/TTL) тестируется без диска.
 *
 * §6B/B3: МУЛЬТИТЕНАНТ — userId В КЛЮЧЕ (один файл на процесс, как consent.ts). РАНЬШЕ ключ был
 * `${channel}:foldName(query)` БЕЗ userId → «Катя» одного юзера резолвилась в peerId ДРУГОГО
 * (отправка НЕ ТОМУ — утечка #2 из аудита). Теперь ключ `${userId}:${channel}:foldName(query)`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../paths.js";
import { type Logger, createLogger, foldName } from "@jarvis/shared";

const log: Logger = createLogger("resolution-memory");
const DEFAULT_DIR = dataDir(); // §универсальность: JARVIS_DATA_DIR (инсталлер) → иначе cwd/data
const FILE_NAME = "resolutions.json";
const TTL_MS = 180 * 24 * 60 * 60 * 1000; // резолв контакта живёт долго; полгода без обращения → выметаем
const MAX_ENTRIES = 1000;
const SAVE_DEBOUNCE_MS = 300;
// Мирроринг seed-пользователя (gateway/identity.ts DEV_USER): старые записи без userId → раздел dev
// (континьюити существующего data/resolutions.json — Антон и есть dev-юзер).
const DEV_USER = "00000000-0000-0000-0000-000000000001";

export interface ResolvedEntry {
  /** §6B/B3: раздел пользователя — часть ключа, иначе резолв одного юзера утечёт другому. */
  userId: string;
  channel: string;
  /** Свёрнутый запрос (foldName) — ключ. Храним и оригинал для диагностики. */
  queryFold: string;
  queryRaw: string;
  /** Стабильный peerId Telegram (если клиент его вернул) — точное открытие следующего раза. */
  peerId?: string;
  /** Имя чата, куда реально ушло (фолбэк-открытие по имени, если peerId нет). */
  title: string;
  hits: number;
  lastAt: number;
}

function keyOf(userId: string, channel: string, query: string): string {
  return `${userId}:${channel}:${foldName(query)}`;
}

/**
 * Хранилище резолвов. Чистая логика (без диска) — для юнит-тестов; персист навешивается loadResolutionMemory.
 */
export class ResolutionMemory {
  private readonly map = new Map<string, ResolvedEntry>();
  private onChange?: () => void;
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Запомнить ВЕРИФИЦИРОВАННЫЙ резолв (userId×query → peerId/title). Перезаписывает, бьёт hits/lastAt. */
  remember(userId: string, channel: string, query: string, resolved: { peerId?: string; title: string }): void {
    const q = String(query ?? "").trim();
    const title = String(resolved.title ?? "").trim();
    if (!userId || !channel || !q || !title) return; // мусор не запоминаем (пустой резолв → не было бы fast-path)
    const k = keyOf(userId, channel, q);
    const prev = this.map.get(k);
    this.map.set(k, {
      userId,
      channel,
      queryFold: foldName(q),
      queryRaw: q,
      peerId: resolved.peerId || prev?.peerId,
      title,
      hits: (prev?.hits ?? 0) + 1,
      lastAt: this.now(),
    });
    this.evict();
    this.onChange?.();
  }

  /** Вспомнить резолв ЭТОГО userId (свежий по TTL). undefined — не помним → общий путь. */
  recall(userId: string, channel: string, query: string): ResolvedEntry | undefined {
    const e = this.map.get(keyOf(userId, channel, query));
    if (!e) return undefined;
    if (this.now() - e.lastAt >= TTL_MS) {
      this.map.delete(keyOf(userId, channel, query));
      this.onChange?.();
      return undefined;
    }
    return e;
  }

  /** Забыть резолв (self-heal: запомненный peerId/title больше не открывается/не доставился). */
  forget(userId: string, channel: string, query: string): void {
    if (this.map.delete(keyOf(userId, channel, query))) this.onChange?.();
  }

  /** Выместить самые старые сверх лимита (по lastAt). */
  private evict(): void {
    if (this.map.size <= MAX_ENTRIES) return;
    const sorted = [...this.map.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
    for (let i = 0; i < sorted.length && this.map.size > MAX_ENTRIES; i += 1) this.map.delete(sorted[i]![0]);
  }

  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  toJSON(): { entries: ResolvedEntry[] } {
    return { entries: [...this.map.values()] };
  }

  /** Загрузить снимок, отбросив протухшие (TTL). Старые записи без userId → раздел dev (континьюити). */
  restore(entries: ResolvedEntry[], now: number = this.now()): void {
    for (const e of entries) {
      if (!e || typeof e.lastAt !== "number" || now - e.lastAt >= TTL_MS) continue;
      const userId = e.userId ?? DEV_USER;
      this.map.set(keyOf(userId, e.channel, e.queryRaw), { ...e, userId });
    }
  }

  get size(): number {
    return this.map.size;
  }
}

// ── персист (зеркало task-store) ─────────────────────────────

interface Persisted {
  savedAt: number;
  entries: ResolvedEntry[];
}

export function readPersisted(dir: string, now: number = Date.now()): ResolvedEntry[] | null {
  const file = join(dir, FILE_NAME);
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Persisted>;
    if (!raw || typeof raw.savedAt !== "number" || !Array.isArray(raw.entries)) return null;
    return raw.entries as ResolvedEntry[];
  } catch (e) {
    log.warn("не удалось прочитать память резолвов", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export function writePersisted(dir: string, snapshot: { entries: ResolvedEntry[] }, now: number = Date.now()): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data: Persisted = { savedAt: now, entries: snapshot.entries };
  const file = join(dir, FILE_NAME);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), "utf8");
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw e;
  }
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingSaves = new Map<string, ResolutionMemory>();

function scheduleSave(dir: string, mem: ResolutionMemory): void {
  const prev = saveTimers.get(dir);
  if (prev) clearTimeout(prev);
  pendingSaves.set(dir, mem);
  const timer = setTimeout(() => {
    saveTimers.delete(dir);
    pendingSaves.delete(dir);
    try {
      writePersisted(dir, mem.toJSON());
    } catch (e) {
      log.warn("не удалось сохранить память резолвов", { error: e instanceof Error ? e.message : String(e) });
    }
  }, SAVE_DEBOUNCE_MS);
  if (typeof timer === "object" && "unref" in timer) (timer as { unref?: () => void }).unref?.();
  saveTimers.set(dir, timer);
}

/** Синхронно сбросить отложенные записи (вызывать в gateway.close()). Идемпотентно. */
export function flushResolutionStores(): void {
  for (const [dir, mem] of pendingSaves) {
    const timer = saveTimers.get(dir);
    if (timer) clearTimeout(timer);
    saveTimers.delete(dir);
    try {
      writePersisted(dir, mem.toJSON());
    } catch (e) {
      log.warn("flush памяти резолвов не удался", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  pendingSaves.clear();
}

/** Загрузить память резолвов с диска + навесить дебаунс-сохранение. */
export function loadResolutionMemory(now: () => number = () => Date.now(), dir: string = DEFAULT_DIR): ResolutionMemory {
  const mem = new ResolutionMemory(now);
  const entries = readPersisted(dir, now());
  if (entries) {
    mem.restore(entries, now());
    log.info("память резолвов восстановлена с диска", { entries: mem.size });
  }
  mem.setOnChange(() => scheduleSave(dir, mem));
  return mem;
}

/**
 * Персист рабочей памяти на диск (§5): контекст диалога ПЕРЕЖИВАЕТ рестарт сервера/клиента и обрыв WS.
 *
 * Раньше WorkingMemory жила только в ОЗУ → любой рестарт (в т.ч. перезапуск сервера при деплое) стирал
 * историю, и Джарвис «забывал, о чём говорили». Теперь храним по userId в data/memory/<user>.json:
 * на старте сессии грузим (если свежее TTL), на каждое изменение — дебаунс-сохранение.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataPath } from "../paths.js";
import { type Entity, type Turn, WorkingMemory } from "./working.js";

const log: Logger = createLogger("working-store");
const DIR = dataPath("memory"); // §универсальность: JARVIS_DATA_DIR (инсталлер) → иначе cwd/data
/** Старше этого восстанавливать не будем — это уже не «продолжение разговора», а другой день. */
const TTL_MS = 12 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 120; // короткий: реплика сохраняется почти сразу → reconnect не теряет последнюю задачу

interface Persisted {
  savedAt: number;
  turns: Turn[];
  entities: Entity[];
}

function fileFor(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";
  return join(DIR, `${safe}.json`);
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Память с НЕсброшенной отложенной записью per-userId — для flush на завершении процесса (H9). */
const pendingSaves = new Map<string, WorkingMemory>();

/** Загрузить рабочую память пользователя с диска (свежую — иначе пустую) + повесить авто-сохранение. */
export function loadWorkingMemory(userId: string): WorkingMemory {
  const mem = new WorkingMemory();
  try {
    const f = fileFor(userId);
    if (existsSync(f)) {
      const raw = JSON.parse(readFileSync(f, "utf8")) as Partial<Persisted>;
      if (raw && typeof raw.savedAt === "number" && Date.now() - raw.savedAt < TTL_MS) {
        mem.restore({ turns: raw.turns, entities: raw.entities });
        log.info("рабочая память восстановлена с диска", { userId, turns: raw.turns?.length ?? 0 });
      }
    }
  } catch (e) {
    log.warn("не удалось загрузить память", { userId, error: e instanceof Error ? e.message : String(e) });
  }
  mem.setOnChange(() => scheduleSave(userId, mem));
  return mem;
}

/** H9: атомарная запись снимка памяти (tmp→rename) — kill посреди записи не оставит усечённый JSON,
 *  из-за которого на boot терялась вся дневная память (writeFileSync писал прямо в финальный путь). */
function writeSnapshot(userId: string, mem: WorkingMemory): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const data: Persisted = { savedAt: Date.now(), ...mem.toJSON() };
  const file = fileFor(userId);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), "utf8");
  try {
    renameSync(tmp, file); // атомарная замена: читатель видит либо старый, либо новый файл целиком
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw e;
  }
}

function scheduleSave(userId: string, mem: WorkingMemory): void {
  const prev = saveTimers.get(userId);
  if (prev) clearTimeout(prev);
  pendingSaves.set(userId, mem);
  const timer = setTimeout(() => {
    saveTimers.delete(userId);
    pendingSaves.delete(userId);
    try {
      writeSnapshot(userId, mem);
    } catch (e) {
      log.warn("не удалось сохранить память", { userId, error: e instanceof Error ? e.message : String(e) });
    }
  }, SAVE_DEBOUNCE_MS);
  if (typeof timer === "object" && "unref" in timer) (timer as { unref?: () => void }).unref?.();
  saveTimers.set(userId, timer);
}

/**
 * H9: синхронно сбросить ВСЕ отложенные записи рабочей памяти (вызывать в gateway.close() перед выходом).
 * Зеркалит flushTaskStores/flushResolutionStores: debounce-таймер unref'нут → на graceful-shutdown он бы
 * НЕ успел сработать, и только что состоявшийся ход потерялся бы («забыл, о чём говорили» после деплоя).
 * Идемпотентно.
 */
export function flushWorkingStores(): void {
  for (const [userId, mem] of pendingSaves) {
    const timer = saveTimers.get(userId);
    if (timer) clearTimeout(timer);
    saveTimers.delete(userId);
    try {
      writeSnapshot(userId, mem);
    } catch (e) {
      log.warn("flush рабочей памяти не удался", { userId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  pendingSaves.clear();
}

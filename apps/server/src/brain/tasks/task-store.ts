/**
 * Персист реестра задач на диск (§5/§20): «что Джарвис сделал» ПЕРЕЖИВАЕТ рестарт сервера.
 *
 * Раньше {@link TaskManager} жил только в ОЗУ → перезапуск сервера при КАЖДОМ деплое стирал историю
 * задач, и на «сделал?» Джарвис отвечал из вытесняемого окна реплик или вовсе не знал. Теперь снимок
 * реестра пишется в data/tasks.json (дебаунс на изменение), а на старте — грузится (если свежий).
 *
 * Зеркалит memory/working-store.ts. Один файл на процесс: TaskManager — общий реестр gateway (§20),
 * мультиюзерность — полем task.userId, не отдельными файлами. Запись атомарна (tmp→rename), чтобы
 * частичный снимок при крэше/антивирусе на Windows не превратился в битый JSON. Чистые read/write
 * вынесены отдельно (тестируются на tmp-каталоге); loadTaskManager навешивает дебаунс-сохранение.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataDir } from "../../paths.js";
import { TaskManager } from "./manager.js";
import type { PersistedTask } from "./task.js";

const log: Logger = createLogger("task-store");
const DEFAULT_DIR = dataDir(); // §универсальность: JARVIS_DATA_DIR (инсталлер) → иначе cwd/data
const FILE_NAME = "tasks.json";
/** Старше этого снимок не восстанавливаем — это история другого дня, не «недавние дела». */
const TTL_MS = 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 300; // частые мутации задачи (прогресс) схлопываются в одну запись

export interface Persisted {
  savedAt: number;
  tasks: PersistedTask[];
}

/** Прочитать снимок реестра из каталога. null, если файла нет / он битый / устарел (TTL). */
export function readPersisted(dir: string, now: number = Date.now()): Persisted | null {
  const file = join(dir, FILE_NAME);
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Persisted>;
    if (!raw || typeof raw.savedAt !== "number" || !Array.isArray(raw.tasks)) return null;
    if (now - raw.savedAt >= TTL_MS) return null; // история другого дня — не «продолжение»
    return { savedAt: raw.savedAt, tasks: raw.tasks };
  } catch (e) {
    log.warn("не удалось прочитать реестр задач", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Записать снимок реестра атомарно (tmp→rename), создав каталог при необходимости. */
export function writePersisted(dir: string, snapshot: { tasks: PersistedTask[] }, now: number = Date.now()): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data: Persisted = { savedAt: now, tasks: snapshot.tasks };
  const file = join(dir, FILE_NAME);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), "utf8");
  try {
    renameSync(tmp, file); // атомарная замена: читатель видит либо старый, либо новый файл целиком
  } catch (e) {
    // rename упал (антивирус/лок на target в Windows) — не оставляем осиротевший .tmp на диске.
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw e;
  }
}

/** Дебаунс-таймеры per-каталог — чтобы параллельные стораджи (в т.ч. в тестах) не мешали друг другу. */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Менеджер с НЕсброшенной отложенной записью per-каталог — для flush на завершении процесса. */
const pendingSaves = new Map<string, TaskManager>();

function scheduleSave(dir: string, tasks: TaskManager): void {
  const prev = saveTimers.get(dir);
  if (prev) clearTimeout(prev);
  pendingSaves.set(dir, tasks);
  const timer = setTimeout(() => {
    saveTimers.delete(dir);
    pendingSaves.delete(dir);
    try {
      writePersisted(dir, tasks.toJSON());
    } catch (e) {
      log.warn("не удалось сохранить реестр задач", { error: e instanceof Error ? e.message : String(e) });
    }
  }, SAVE_DEBOUNCE_MS);
  if (typeof timer === "object" && "unref" in timer) (timer as { unref?: () => void }).unref?.();
  saveTimers.set(dir, timer);
}

/**
 * Синхронно сбросить ВСЕ отложенные записи реестра (вызывать в gateway.close() перед выходом).
 * Таймер дебаунса unref'нут → на graceful-shutdown (SIGTERM/деплой) он бы НЕ успел сработать, и
 * задача, завершённая за <300мс до рестарта, потерялась бы — ровно тот «сделал? после деплоя», ради
 * которого вся фича. Здесь дописываем такие задачи сразу (writePersisted атомарна). Идемпотентно.
 */
export function flushTaskStores(): void {
  for (const [dir, tasks] of pendingSaves) {
    const timer = saveTimers.get(dir);
    if (timer) clearTimeout(timer);
    saveTimers.delete(dir);
    try {
      writePersisted(dir, tasks.toJSON());
    } catch (e) {
      log.warn("flush реестра задач не удался", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  pendingSaves.clear();
}

/**
 * Загрузить реестр задач с диска (свежий — иначе пустой) и навесить дебаунс-авто-сохранение.
 * @param now источник времени (инъектируется в тестах); по умолчанию системные часы.
 * @param dir каталог хранения (инъектируется в тестах); по умолчанию <cwd>/data.
 */
export function loadTaskManager(now: () => number = () => Date.now(), dir: string = DEFAULT_DIR): TaskManager {
  const tasks = new TaskManager(now);
  const snap = readPersisted(dir, now());
  if (snap) {
    tasks.restore({ tasks: snap.tasks }, now());
    log.info("реестр задач восстановлен с диска", { tasks: snap.tasks.length });
  }
  tasks.setOnChange(() => scheduleSave(dir, tasks));
  return tasks;
}

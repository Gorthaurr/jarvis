/**
 * Волна C: durable-хранилище чекпойнтов прерванных задач (§5 «переживает рестарт»).
 *
 * Одна запись НА ПОЛЬЗОВАТЕЛЯ — последняя прерванная задача. Это осознанно: «продолжи» без
 * уточнения означает «то, на чём мы только что встали», а держать очередь недоделок и угадывать,
 * какую из них имел в виду владелец, — источник ложных продолжений.
 *
 * Персист нужен именно здесь: сервер перезапускается на КАЖДЫЙ деплой, а «продолжи» звучит через
 * минуты после обрыва — в ОЗУ чекпойнт бы не дожил ровно в самом частом сценарии.
 *
 * Запись атомарна (tmp→rename), любой сбой ФС — предупреждение в лог и деградация к «чекпойнта нет»
 * (тогда терминал НЕ обещает продолжение — см. agent/index.ts). Зеркалит tasks/task-store.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataDir } from "../../paths.js";
import type { TaskCheckpoint } from "./checkpoint.js";

const log: Logger = createLogger("checkpoint-store");
const FILE_NAME = "checkpoints.json";

/** Сколько чекпойнт «живой». Старше — продолжать нечего: мир ушёл вперёд, честнее начать заново. */
export function checkpointTtlMs(): number {
  const n = Number.parseInt(process.env.JARVIS_CHECKPOINT_TTL_MS ?? "", 10);
  return Number.isFinite(n) ? Math.min(24 * 60 * 60_000, Math.max(60_000, n)) : 30 * 60_000;
}

/** Выключатель фичи целиком (аварийный откат к прежнему поведению «прервалось — и всё»). */
export function checkpointsEnabled(): boolean {
  return process.env.JARVIS_TASK_CHECKPOINT !== "0";
}

interface Persisted {
  savedAt: number;
  items: TaskCheckpoint[];
}

/** Прочитать снимок с диска. null — файла нет/битый (деградация к «чекпойнтов нет»). */
export function readCheckpoints(dir: string): Persisted | null {
  const file = join(dir, FILE_NAME);
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Persisted>;
    if (!raw || typeof raw.savedAt !== "number" || !Array.isArray(raw.items)) return null;
    return { savedAt: raw.savedAt, items: raw.items.filter(isCheckpoint) };
  } catch (e) {
    log.warn("не удалось прочитать чекпойнты задач", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Минимальная валидация записи (чужой/старый формат не должен ронять резюме). */
function isCheckpoint(v: unknown): v is TaskCheckpoint {
  const c = v as Partial<TaskCheckpoint> | null;
  return Boolean(
    c &&
      typeof c.userId === "string" &&
      typeof c.taskId === "string" &&
      typeof c.goal === "string" &&
      typeof c.digest === "string" &&
      typeof c.savedAt === "number" &&
      typeof c.round === "number",
  );
}

/** Записать снимок атомарно (tmp→rename), создав каталог при необходимости. */
export function writeCheckpoints(dir: string, items: TaskCheckpoint[], now: number = Date.now()): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, FILE_NAME);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ savedAt: now, items } satisfies Persisted), "utf8");
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp); // не оставляем осиротевший .tmp (лок антивируса на Windows)
    } catch {
      /* best-effort */
    }
    throw e;
  }
}

/**
 * Стор чекпойнтов: последняя прерванная задача каждого пользователя.
 * Состояние держится в ОЗУ, зеркалится на диск при каждом изменении (запись редкая — на обрыв задачи).
 */
export class CheckpointStore {
  private readonly items = new Map<string, TaskCheckpoint>();

  constructor(
    private readonly dir: string = dataDir(),
    private readonly now: () => number = () => Date.now(),
  ) {
    const snap = readCheckpoints(this.dir);
    if (snap) {
      // Протухшие не поднимаем в ОЗУ: они всё равно не отдаются (TTL), а содержат выжимки страниц/
      // писем прошлого захода — держать их на диске дольше нужного незачем.
      const ttl = checkpointTtlMs();
      const alive = snap.items.filter((cp) => this.now() - cp.savedAt <= ttl);
      for (const cp of alive) this.items.set(cp.userId, cp);
      if (alive.length) log.info("чекпойнты прерванных задач восстановлены", { count: alive.length });
      if (alive.length !== snap.items.length) this.flush(); // вычистить протухшее с диска
    }
  }

  /** Убрать протухшие записи (вызывается перед записью — файл не копит чужие старые журналы). */
  private pruneExpired(): void {
    const ttl = checkpointTtlMs();
    const now = this.now();
    for (const [userId, cp] of this.items) {
      if (now - cp.savedAt > ttl) this.items.delete(userId);
    }
  }

  /**
   * Сохранить чекпойнт (перетирает прежний этого пользователя). false — не сохранили (выключено или
   * сбой ФС): вызывающий ОБЯЗАН не обещать владельцу продолжение.
   */
  save(cp: TaskCheckpoint, chainFrom?: string): boolean {
    if (!checkpointsEnabled()) return false;
    const prev = this.items.get(cp.userId);
    // chainFrom — taskId прошлого звена ТОЙ ЖЕ цепочки продолжений: у продолжения всегда новый taskId,
    // и без этого штатное «прервалось → доделай → снова прервалось» печатало ЛОЖНЫЙ WARN об
    // аннулированном обещании по «другой» задаче (контрольное ревью-2).
    if (prev && prev.taskId !== cp.taskId && prev.taskId !== chainFrom && this.now() - prev.savedAt <= checkpointTtlMs()) {
      // Слот один на пользователя (осознанно — см. шапку). Но перетирание ЖИВОЙ недоделки другой
      // задачи молча обесценивает уже данное по ней обещание — пусть это хотя бы видно в логе.
      log.warn("чекпойнт другой задачи перетёрт — прежнее обещание продолжить по ней больше не в силе", {
        droppedTaskId: prev.taskId,
        droppedTitle: prev.title,
        newTaskId: cp.taskId,
      });
    }
    this.items.set(cp.userId, cp);
    if (!this.flush()) {
      // Диск не принял. В ОЗУ чекпойнт остаётся (в этом процессе «продолжи» сработает), но ОБЕЩАТЬ
      // продолжение владельцу нельзя — рестарта такой чекпойнт не переживёт. Недо-обещание безопасно:
      // если владелец всё равно скажет «продолжи», мы продолжим.
      log.warn("чекпойнт не записан на диск — переживёт только текущий процесс", { taskId: cp.taskId });
      return false;
    }
    return true;
  }

  /**
   * Отметить, что предложение продолжить РЕАЛЬНО прозвучало (взводит окно, в котором у плеера
   * отбирается голое «продолжи»). Отдельно от save: сохранить можно и молча (обновление журнала
   * после провала, сбой записи на диск) — а обещать нельзя.
   */
  markOffered(userId: string, taskId: string): void {
    const cp = this.items.get(userId);
    if (!cp || cp.taskId !== taskId) return;
    cp.offeredAt = this.now();
    this.flush();
  }

  /**
   * Обновить ЖУРНАЛ живого чекпойнта, НЕ трогая факт предложения.
   *
   * 🔴 Зачем (контрольное ревью, HIGH): продолжение могло сделать необратимое (отправить письмо) и
   * завершиться терминалом, который чекпойнт не пишет (стаб LLM, ошибка, отмена, spend-cap). Тогда в
   * сторе оставался журнал ПРОШЛОГО захода — без свежих отправок, — и следующее «доделай» повторяло
   * их людям. Журнал обязан быть не старее реальности; предложение при этом не переигрываем.
   */
  refreshJournal(userId: string, taskId: string, digest: string, round: number): void {
    const cp = this.items.get(userId);
    if (!cp || cp.taskId !== taskId) return;
    cp.digest = digest;
    cp.round = round;
    // ⚠️ savedAt НЕ двигаем (контрольное ревью-2): TTL — срок годности НАБЛЮДЕНИЙ прошлого захода, а не
    // отметка последней записи. Иначе провалившееся продолжение «омолаживало» чекпойнт, и отменённая
    // владельцем работа жила ещё полные 30 минут.
    this.flush();
  }

  /** Живой чекпойнт пользователя (с учётом TTL), без потребления. */
  peek(userId: string): TaskCheckpoint | null {
    if (!checkpointsEnabled()) return null;
    const cp = this.items.get(userId);
    if (!cp) return null;
    if (this.now() - cp.savedAt > checkpointTtlMs()) {
      this.items.delete(userId);
      this.flush();
      return null;
    }
    // 🔴 КОПИЯ, не живая ссылка (контрольное ревью-3): вызывающий держит её как `opts.resumeFrom`, а
    // `refreshJournal` мутирует запись в сторе — через алиас `resumeFrom.digest` подменялся УЖЕ
    // смерженным, и `saveCheckpoint` мержил свежий журнал ВТОРОЙ раз, вытесняя первый заход.
    return { ...cp };
  }

  /**
   * Взять чекпойнт для продолжения и УДАЛИТЬ его (одноразовость): повторное «продолжи» не должно
   * во второй раз поднимать тот же устаревший журнал. Новый обрыв положит свежий чекпойнт.
   */
  take(userId: string): TaskCheckpoint | null {
    const cp = this.peek(userId);
    if (!cp) return null;
    this.items.delete(userId);
    this.flush();
    return cp;
  }

  /** Снять чекпойнт (задача доведена/отменена — продолжать нечего). */
  clear(userId: string): void {
    if (this.items.delete(userId)) this.flush();
  }

  /**
   * Снять чекпойнт, ТОЛЬКО если он всё ещё тот самый (ревью): продолжение доводит задачу до конца и
   * гасит свой журнал — но за время работы параллельная задача могла положить в слот СВОЙ чекпойнт,
   * и его стирать нельзя (иначе успех одной задачи молча съедал бы недоделку другой).
   */
  clearIf(userId: string, taskId: string): void {
    if (this.items.get(userId)?.taskId === taskId) this.clear(userId);
  }

  /** Записать текущее состояние на диск; false — сбой (уже залогирован). */
  private flush(): boolean {
    try {
      this.pruneExpired();
      writeCheckpoints(this.dir, [...this.items.values()], this.now());
      return true;
    } catch (e) {
      log.warn("не удалось сохранить чекпойнты задач", { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }
}

/** Загрузить стор чекпойнтов (dir/now инъектируются в тестах). */
export function loadCheckpointStore(dir: string = dataDir(), now: () => number = () => Date.now()): CheckpointStore {
  return new CheckpointStore(dir, now);
}

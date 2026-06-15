/**
 * Реестр долгих задач (§20) — in-process per-process центр учёта M8.
 *
 * Менеджер хранит {@link Task} по taskId и обслуживает жизненный цикл (§20):
 * create → running → (pause/resume) → done/failed/cancelled. Команды голоса/UI
 * («стоп»/«отмени»/«пауза»/«продолжи»/«что делаешь») приходят без taskId — для них
 * есть {@link TaskManager.active}, возвращающий самую свежую живую задачу сессии.
 *
 * Ключевая инвариантность §20: cancel НЕ заменяет объект cancel-флага, а мутирует
 * `cancelled=true` ровно у того экземпляра {@link CancelFlag}, что вернул create(),
 * чтобы петля агента, держащая ссылку на `task.cancel`, увидела отмену перед шагом.
 *
 * Часы инъецируются (now: () => number, unix ms) — чтобы тесты прогресса/sweep/
 * сортировки были детерминированы и не зависели от системного времени.
 */
import { newId } from "@jarvis/protocol";
import type { Task, TaskState } from "./task.js";
import { isActiveState, isTerminalState } from "./task.js";

/** Параметры создания задачи (§20): кто, в какой сессии, что просили. */
export interface CreateTaskOpts {
  userId: string;
  sessionId: string;
  /** Человеческая формулировка цели («сделай таблицу расходов»). */
  goal: string;
  /** Всего шагов — для скилла известно; undefined для open-ended LLM-петли. */
  stepsTotal?: number;
}

/** TTL по умолчанию для sweep: терминальные задачи живут 10 минут (§20-отчётность). */
const DEFAULT_SWEEP_TTL_MS = 10 * 60 * 1000;

/**
 * In-process реестр задач (§20). Один на процесс; per-user/per-session — фильтрами
 * по полям задачи. Без внешних зависимостей и без таймеров: течение времени и
 * чистка управляются явными вызовами progress/sweep с инъецированным now.
 */
export class TaskManager {
  /** taskId → задача. Map сохраняет порядок вставки (полезно для list/active). */
  private readonly tasks = new Map<string, Task>();

  /**
   * @param now источник unix-ms времени. По умолчанию системные часы; тесты
   *   ВСЕГДА передают свою функцию для детерминизма.
   */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Создать задачу в состоянии "running" (§20): прогресс 0, свежий cancel-флаг
   * {cancelled:false}, taskId через newId(), startedAt по инъецированным часам.
   */
  create(opts: CreateTaskOpts): Task {
    const task: Task = {
      taskId: newId(),
      userId: opts.userId,
      sessionId: opts.sessionId,
      goal: opts.goal,
      state: "running",
      stepsDone: 0,
      stepsTotal: opts.stepsTotal,
      startedAt: this.now(),
      cancel: { cancelled: false },
    };
    this.tasks.set(task.taskId, task);
    return task;
  }

  /** Задача по id (или undefined, если нет/была вычищена sweep). */
  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Самая свежая НЕтерминальная задача сессии (§20) — адресат команд без taskId
   * («стоп», «продолжи», «что делаешь»). По startedAt desc среди активных.
   */
  active(sessionId: string): Task | undefined {
    let best: Task | undefined;
    for (const task of this.tasks.values()) {
      if (task.sessionId !== sessionId) continue;
      if (!isActiveState(task.state)) continue;
      if (!best || task.startedAt > best.startedAt) best = task;
    }
    return best;
  }

  /** Задачи пользователя, свежие первыми (по startedAt desc) — для списка/истории. */
  list(userId: string): Task[] {
    return [...this.tasks.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Обновить прогресс активной задачи (§20). No-op (undefined) для терминальной:
   * после done/failed/cancelled прогресс не меняется. stepsTotal обновляется,
   * только если передан явно.
   */
  progress(taskId: string, stepsDone: number, stepsTotal?: number): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task || isTerminalState(task.state)) return undefined;
    task.stepsDone = stepsDone;
    if (stepsTotal !== undefined) task.stepsTotal = stepsTotal;
    return task;
  }

  /**
   * §20: «отмени» — прервать задачу. Мутирует cancel.cancelled=true (ТОТ ЖЕ объект,
   * что у петли агента), выставляет state "cancelled" и finishedAt. Идемпотентно:
   * false, если задачи нет или она уже терминальна.
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || isTerminalState(task.state)) return false;
    task.cancel.cancelled = true;
    task.state = "cancelled";
    task.finishedAt = this.now();
    return true;
  }

  /**
   * §20: снять ВСЕ незавершённые задачи сессии. Нужно для параллельного режима:
   * голосовое «отмени» означает «останови всё, что делаешь», а активных задач может
   * быть несколько (Semaphore>1). Мутирует cancel.cancelled у каждой (петли увидят) и
   * переводит в "cancelled". Возвращает снятые задачи (для стрима task.status в UI).
   */
  cancelSession(sessionId: string): Task[] {
    const cancelled: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.sessionId !== sessionId || isTerminalState(task.state)) continue;
      task.cancel.cancelled = true;
      task.state = "cancelled";
      task.finishedAt = this.now();
      cancelled.push(task);
    }
    return cancelled;
  }

  /** §20: «пауза» — running/queued → paused. false для прочих состояний. */
  pause(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.state !== "running" && task.state !== "queued") return false;
    task.state = "paused";
    return true;
  }

  /** §20: «продолжи» — paused → running. false, если задача не на паузе. */
  resume(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "paused") return false;
    task.state = "running";
    return true;
  }

  /**
   * Успешное завершение (§20): state "done", finishedAt, resultSummary для отчёта.
   * No-op (undefined), если задачи нет или она уже терминальна.
   */
  finish(taskId: string, summary?: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task || isTerminalState(task.state)) return undefined;
    task.state = "done";
    task.finishedAt = this.now();
    if (summary !== undefined) task.resultSummary = summary;
    return task;
  }

  /**
   * Провал (§20): state "failed", finishedAt, lastError (причина для errorReport).
   * No-op (undefined), если задачи нет или она уже терминальна.
   */
  fail(taskId: string, error: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task || isTerminalState(task.state)) return undefined;
    task.state = "failed";
    task.finishedAt = this.now();
    task.lastError = error;
    return task;
  }

  /**
   * Чистка завершённых задач (§20): удалить терминальные с finishedAt старше ttlMs
   * относительно переданного now. Активные задачи не трогаем. Возвращает число
   * удалённых.
   */
  sweep(now: number, ttlMs: number = DEFAULT_SWEEP_TTL_MS): number {
    let removed = 0;
    for (const [taskId, task] of this.tasks) {
      if (!isTerminalState(task.state)) continue;
      const finishedAt = task.finishedAt ?? task.startedAt;
      if (now - finishedAt > ttlMs) {
        this.tasks.delete(taskId);
        removed += 1;
      }
    }
    return removed;
  }
}
